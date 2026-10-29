'use strict';
/*
 * SC Signage server — local digital signage for LAN use, modelled on piSignage:
 *   Assets → Playlists (zone layouts) → Groups (players, schedules, TV on/off) → Deploy
 *
 *   /admin   management UI (basic auth)
 *   /player  player page (Android box app, or any browser)
 *   /media   uploaded media
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const HTML_DIR = path.join(MEDIA_DIR, 'html');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '2048', 10);
const ONLINE_WINDOW_MS = 90 * 1000;

for (const d of [MEDIA_DIR, HTML_DIR, SNAP_DIR]) fs.mkdirSync(d, { recursive: true });

// zones of each layout, in % of the screen: [left, top, width, height] (sizes as in piSignage)
const LAYOUTS = {
  '1': { main: [0, 0, 100, 100] },
  '2a': { side: [0, 0, 25, 100], main: [25, 0, 75, 100] },
  '2b': { main: [0, 0, 75, 100], side: [75, 0, 25, 100] },
  '2c': { main: [0, 0, 50, 100], side: [50, 0, 50, 100] },
  '2d': { side: [0, 0, 50, 100], main: [50, 0, 50, 100] },
  '3a': { side: [0, 0, 25, 75], main: [25, 0, 75, 75], bottom: [0, 75, 100, 25] },
  '3b': { main: [0, 0, 75, 75], side: [75, 0, 25, 75], bottom: [0, 75, 100, 25] },
  '3c': { bottom: [0, 0, 100, 25], side: [0, 25, 25, 75], main: [25, 25, 75, 75] },
  '3d': { bottom: [0, 0, 100, 25], main: [0, 25, 75, 75], side: [75, 25, 25, 75] },
  '4a': { side: [0, 0, 25, 100], main: [25, 0, 75, 75], bottom: [25, 75, 75, 25] },
  '4b': { main: [0, 0, 75, 75], bottom: [0, 75, 75, 25], side: [75, 0, 25, 100] },
  '4c': { side: [0, 0, 25, 100], bottom: [25, 0, 75, 25], main: [25, 25, 75, 75] },
  '4d': { bottom: [0, 0, 75, 25], main: [0, 25, 75, 75], side: [75, 0, 25, 100] },
  '2bp': { main: [0, 0, 100, 42.19], side: [0, 42.19, 100, 57.81] } // portrait: main top, side below
};

// ซึ่ง layout ปรับขนาดโซนข้าง/ล่างได้ (side = ความกว้างโซนข้าง %, bottom = ความสูงโซนล่าง %)
// layout อื่นใช้สัดส่วนตายตัว
const ADJUSTABLE = { '2a': 1, '2b': 1, '2c': 1, '2d': 1, '3a': 1, '3b': 1, '2bp': 1 };
const clampN = (v, lo, hi, def) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

// คืนพิกัดโซนของ playlist หลังปรับขนาด (ถ้าไม่ปรับ = ค่าตั้งต้นของ layout)
function resolvedZones(layout, adj) {
  const base = LAYOUTS[layout] || LAYOUTS['1'];
  if (!ADJUSTABLE[layout] || !adj) return base;
  const sp = adj.side, bp = adj.bottom;
  switch (layout) {
    case '2a': case '2d': { const w = clampN(sp, 10, 60, layout === '2d' ? 50 : 25); return { side: [0, 0, w, 100], main: [w, 0, 100 - w, 100] }; }
    case '2b': case '2c': { const w = clampN(sp, 10, 60, layout === '2c' ? 50 : 25); return { main: [0, 0, 100 - w, 100], side: [100 - w, 0, w, 100] }; }
    case '3a': { const w = clampN(sp, 10, 60, 25), h = clampN(bp, 8, 45, 25); return { side: [0, 0, w, 100 - h], main: [w, 0, 100 - w, 100 - h], bottom: [0, 100 - h, 100, h] }; }
    case '3b': { const w = clampN(sp, 10, 60, 25), h = clampN(bp, 8, 45, 25); return { main: [0, 0, 100 - w, 100 - h], side: [100 - w, 0, w, 100 - h], bottom: [0, 100 - h, 100, h] }; }
    case '2bp': { const sh = clampN(sp, 20, 80, 57.81); return { main: [0, 0, 100, 100 - sh], side: [0, 100 - sh, 100, sh] }; }
    default: return base;
  }
}

function cleanZoneAdjust(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  if (a.side != null) out.side = clampN(a.side, 10, 80, 25);
  if (a.bottom != null) out.bottom = clampN(a.bottom, 8, 45, 25);
  return Object.keys(out).length ? out : null;
};

// ---------------------------------------------------------------- storage
const newId = (prefix) => prefix + crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

function emptyDb() {
  return {
    version: 2,
    rev: 1,
    assets: [],
    playlists: [],
    groups: [{ id: 'gdefault', name: 'ค่าเริ่มต้น', ...groupDefaults() }],
    players: [],
    settings: { emergency: { enabled: false, message: '', playlistId: '' } }
  };
}

function groupDefaults() {
  return {
    orientation: 0,
    defaultPlaylist: '',
    schedules: [],
    tv: { enabled: false, rows: [] },
    deployed: null,
    createdAt: nowIso()
  };
}

// Upgrade a version-1 database (screens/media) to the piSignage-style model.
function migrateV1(old) {
  const db = emptyDb();
  db.rev = (old.rev || 1) + 1;
  db.assets = (old.media || []).map((m) => ({ ...m }));
  const s = old.settings || {};
  const ticker = { enabled: !!(s.tickerEnabled && s.tickerText), text: s.tickerText || '', speed: s.tickerSpeed || 80 };
  db.playlists = (old.playlists || []).map((p) => ({
    id: p.id,
    name: p.name,
    layout: '1',
    ticker: { ...ticker },
    items: (p.items || []).map((it) => ({ main: it.mediaId, side: '', bottom: '', duration: it.duration || 0, fit: it.fit, muted: !!it.muted }))
  }));
  db.groups = [];
  const byName = {};
  for (const sc of old.screens || []) {
    const gname = sc.group || 'ค่าเริ่มต้น';
    let g = byName[gname];
    if (!g) {
      g = { id: gname === 'ค่าเริ่มต้น' ? 'gdefault' : newId('g'), name: gname, ...groupDefaults(),
        orientation: sc.rotation || 0, defaultPlaylist: sc.defaultPlaylist || '', schedules: sc.schedules || [] };
      byName[gname] = g;
      db.groups.push(g);
    }
    db.players.push({ id: sc.id, name: sc.name, location: sc.location || '', groupId: g.id, lastSeen: sc.lastSeen, ip: sc.ip, agent: sc.agent, reloadAt: 0, createdAt: sc.createdAt });
  }
  if (!db.groups.some((g) => g.id === 'gdefault')) db.groups.unshift({ id: 'gdefault', name: 'ค่าเริ่มต้น', ...groupDefaults() });
  db.groups.sort((a, b) => (a.id === 'gdefault' ? -1 : b.id === 'gdefault' ? 1 : 0));
  return { db, deployAll: true };
}

function loadDb() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('db.json unreadable:', e.message);
      fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
    }
    return { db: emptyDb(), deployAll: false };
  }
  if (raw.version !== 2) {
    fs.copyFileSync(DB_FILE, DB_FILE + '.v1-backup');
    console.log('migrating database v1 → v2 (backup: db.json.v1-backup)');
    return migrateV1(raw);
  }
  const db = Object.assign(emptyDb(), raw);
  db.settings = Object.assign(emptyDb().settings, raw.settings);
  return { db, deployAll: false };
}

const loaded = loadDb();
let db = loaded.db;
let saveTimer = null;

function writeDbNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function commit() { db.rev += 1; writeDbNow(); }
function saveLater() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDbNow(); }, 15000);
}

// ---------------------------------------------------------------- validation
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOr = (v) => (DATE_RE.test(v || '') ? v : '');
const timeOr = (v, d) => (TIME_RE.test(v || '') ? v : d);
const days = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((d) => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6]);
const assetById = (id) => db.assets.find((a) => a.id === id);

function cleanSchedules(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && db.playlists.some((p) => p.id === s.playlistId)).map((s) => ({
    playlistId: s.playlistId, days: days(s.days),
    start: timeOr(s.start, '00:00'), end: timeOr(s.end, '23:59'),
    dateFrom: dateOr(s.dateFrom), dateTo: dateOr(s.dateTo)
  }));
}

function cleanTv(tv) {
  tv = tv || {};
  return {
    enabled: !!tv.enabled,
    rows: (Array.isArray(tv.rows) ? tv.rows : []).map((r) => ({
      days: days(r.days), on: timeOr(r.on, '07:00'), off: timeOr(r.off, '18:00'),
      dateFrom: dateOr(r.dateFrom), dateTo: dateOr(r.dateTo)
    }))
  };
}

// ---- คำนวณว่าทีวีควรเปิดอยู่ไหมตอนนี้ (ตรรกะเดียวกับที่จอใช้) สำหรับ ESP32 ตัดไฟทีวี ----
const toMin = (t) => { const p = String(t).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function tvWindow(row, d) {
  const today = ymdLocal(d);
  if (row.dateFrom && today < row.dateFrom) return false;
  if (row.dateTo && today > row.dateTo) return false;
  const m = d.getHours() * 60 + d.getMinutes(), a = toMin(row.on), b = toMin(row.off), day = d.getDay();
  if (a <= b) return row.days.indexOf(day) >= 0 && m >= a && m < b;
  if (m >= a) return row.days.indexOf(day) >= 0;            // ข้ามเที่ยงคืน: ช่วงหัวค่ำ
  if (m < b) return row.days.indexOf((day + 6) % 7) >= 0;   // ข้ามเที่ยงคืน: ช่วงเช้ามืด (นับเป็นของเมื่อวาน)
  return false;
}
function tvOnNow(tv, d) {
  if (!tv || !tv.enabled || !tv.rows || !tv.rows.length) return true; // ไม่ตั้งตาราง = เปิดตลอด
  const today = ymdLocal(d), dated = [], weekly = [];
  for (const r of tv.rows) {
    if (r.dateFrom || r.dateTo) { if ((!r.dateFrom || today >= r.dateFrom) && (!r.dateTo || today <= r.dateTo)) dated.push(r); }
    else weekly.push(r);
  }
  const rows = dated.length ? dated : weekly; // วันพิเศษ (มีช่วงวันที่) ทับตารางรายสัปดาห์
  return rows.some((r) => tvWindow(r, d));
}

function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  const ok = (id) => (id && assetById(id) ? id : '');
  return list.filter((it) => it && assetById(it.main)).map((it) => ({
    main: it.main, side: ok(it.side), bottom: ok(it.bottom),
    duration: Math.max(0, Math.min(3600, parseInt(it.duration, 10) || 0)),
    fit: it.fit === 'cover' ? 'cover' : 'contain',
    muted: !!it.muted
  }));
}

function cleanTicker(t) {
  t = t || {};
  return { enabled: !!t.enabled, text: String(t.text || '').slice(0, 2000), speed: Math.max(20, Math.min(400, parseInt(t.speed, 10) || 80)) };
}

function cleanNotice(n) {
  n = n || {};
  const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
  return {
    title: String(n.title || '').slice(0, 300),
    body: String(n.body || '').slice(0, 3000),
    footer: String(n.footer || '').slice(0, 300),
    bg: color(n.bg, '#e5761b'),
    color: color(n.color, '#ffffff'),
    image: n.image && assetById(n.image) && assetById(n.image).type === 'image' ? n.image : ''
  };
}

// ---------------------------------------------------------------- building player content
function defaultDuration(type) { return type === 'video' ? 0 : type === 'web' || type === 'html' ? 30 : 10; }

function assetSrc(a) {
  if (a.type === 'web') return a.url;
  if (a.type === 'html') return '/media/html/' + a.id + '/' + a.entry;
  if (a.type === 'notice') return '';
  return '/media/' + a.file;
}

function assetPayload(id) {
  const a = assetById(id);
  if (!a) return null;
  const out = { id: a.id, name: a.name, type: a.type, src: assetSrc(a), validFrom: a.validFrom || '', validTo: a.validTo || '' };
  if (a.type === 'notice') {
    const n = a.notice || {};
    const img = n.image && assetById(n.image);
    out.notice = { title: n.title, body: n.body, footer: n.footer, bg: n.bg, color: n.color, image: img ? '/media/' + img.file : '' };
  }
  return out;
}

function playlistPayload(p) {
  return {
    id: p.id,
    name: p.name,
    layout: LAYOUTS[p.layout] ? p.layout : '1',
    zones: resolvedZones(LAYOUTS[p.layout] ? p.layout : '1', p.zoneAdjust), // พิกัดโซนที่ปรับขนาดแล้ว
    ticker: p.ticker,
    items: p.items.map((it) => {
      const main = assetPayload(it.main);
      if (!main) return null;
      return {
        main, side: it.side ? assetPayload(it.side) : null, bottom: it.bottom ? assetPayload(it.bottom) : null,
        duration: it.duration || defaultDuration(main.type), fit: it.fit, muted: it.muted
      };
    }).filter(Boolean)
  };
}

// What a group's players get after Deploy (frozen until the next deploy).
function buildGroupContent(g) {
  const used = new Set([g.defaultPlaylist, ...g.schedules.map((s) => s.playlistId)].filter(Boolean));
  const playlists = {};
  for (const p of db.playlists) if (used.has(p.id)) playlists[p.id] = playlistPayload(p);
  return { orientation: g.orientation, defaultPlaylist: g.defaultPlaylist, schedules: g.schedules, tv: g.tv, playlists, layouts: LAYOUTS };
}

function deployGroup(g) {
  g.deployed = { at: nowIso(), content: buildGroupContent(g) };
}

function groupStatus(g) {
  return {
    ...g,
    deployed: g.deployed ? { at: g.deployed.at } : null,
    pendingChanges: !g.deployed || JSON.stringify(g.deployed.content) !== JSON.stringify(buildGroupContent(g)),
    playerCount: db.players.filter((p) => p.groupId === g.id).length
  };
}

// Media files still referenced by any deployed content (kept even after an asset is deleted).
function referencedFiles() {
  const files = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'string' && v.startsWith('/media/')) files.add(v.slice(7).split('/').slice(0, v.startsWith('/media/html/') ? 2 : 1).join('/'));
      else walk(v);
    }
  };
  for (const g of db.groups) if (g.deployed) walk(g.deployed.content);
  for (const a of db.assets) {
    if (a.file) files.add(a.file);
    if (a.type === 'html') files.add('html/' + a.id);
  }
  return files;
}

function collectGarbage() {
  const keep = referencedFiles();
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (f === 'html' || keep.has(f)) continue;
    fs.rm(path.join(MEDIA_DIR, f), { force: true }, () => {});
  }
  for (const d of fs.readdirSync(HTML_DIR)) {
    if (!keep.has('html/' + d)) fs.rm(path.join(HTML_DIR, d), { recursive: true, force: true }, () => {});
  }
}

function playerConfig(pl) {
  const g = db.groups.find((x) => x.id === pl.groupId) || db.groups.find((x) => x.id === 'gdefault');
  const em = db.settings.emergency;
  const emPl = em.enabled && em.playlistId ? db.playlists.find((p) => p.id === em.playlistId) : null;
  return {
    rev: db.rev,
    serverTime: Date.now(),
    player: { id: pl.id, name: pl.name, group: g ? g.name : '', reloadAt: pl.reloadAt || 0, snapshotReq: pl.snapshotReq || 0 },
    content: g && g.deployed ? g.deployed.content : null,
    deployedAt: g && g.deployed ? g.deployed.at : '',
    emergency: em.enabled ? { message: em.message, playlist: emPl ? playlistPayload(emPl) : null } : null
  };
}

function newPlayer(id) {
  const def = db.groups.find((g) => g.id === 'gdefault') || db.groups[0];
  const pl = { id, name: 'จอใหม่ ' + id, location: '', groupId: def ? def.id : '', reloadAt: 0, createdAt: nowIso() };
  db.players.push(pl);
  commit();
  console.log('new player registered:', id);
  return pl;
}

function playerPublic(p) {
  const snap = path.join(SNAP_DIR, p.id + '.jpg');
  let snapshotAt = '';
  try { snapshotAt = fs.statSync(snap).mtime.toISOString(); } catch (e) {}
  return { ...p, online: !!p.lastSeen && Date.now() - Date.parse(p.lastSeen) < ONLINE_WINDOW_MS, snapshotAt };
}

if (loaded.deployAll) {
  for (const g of db.groups) deployGroup(g);
  commit();
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const cleanPlayerId = (v) => String(v).replace(/[^\w.-]/g, '').slice(0, 64);

// --- player side (no auth: screens on the LAN must reach it unattended)
app.get('/api/player/:id', (req, res) => {
  const id = cleanPlayerId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  let pl = db.players.find((p) => p.id === id);
  res.set('Cache-Control', 'no-store');
  if (req.query.preview === '1') {
    if (!pl) return res.status(404).json({ error: 'unknown player' });
    return res.json(playerConfig(pl));
  }
  if (!pl) pl = newPlayer(id);
  pl.lastSeen = nowIso();
  pl.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim().replace(/^::ffff:/, '');
  pl.agent = String(req.query.app || '').slice(0, 40);
  pl.version = String(req.query.v || '').slice(0, 20);
  pl.playing = {
    playlist: String(req.query.pl || '').slice(0, 120),
    asset: String(req.query.asset || '').slice(0, 200),
    tv: req.query.tv === '0' ? 'off' : 'on'
  };
  saveLater();
  res.json(playerConfig(pl));
});

app.post('/api/player/:id/snapshot', express.raw({ type: 'image/jpeg', limit: '3mb' }), (req, res) => {
  const pl = db.players.find((p) => p.id === cleanPlayerId(req.params.id));
  if (!pl || !Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'bad snapshot' });
  fs.writeFile(path.join(SNAP_DIR, pl.id + '.jpg'), req.body, () => res.json({ ok: true }));
});

// สถานะทีวีเปิด/ปิดตอนนี้ของกลุ่ม — สำหรับ ESP32 ตัดไฟทีวีตามตารางเดียวกับจอ
// เรียกด้วย groupId หรือ playerId; ?fmt=text คืน "1"/"0" ล้วนๆ ให้ ESP32 อ่านง่าย
app.get('/api/tv/:id', (req, res) => {
  const id = String(req.params.id);
  let g = db.groups.find((x) => x.id === id);
  if (!g) { const pl = db.players.find((p) => p.id === cleanPlayerId(id)); if (pl) g = db.groups.find((x) => x.id === pl.groupId); }
  res.set('Cache-Control', 'no-store');
  if (!g) return res.status(404).type('text/plain').send(req.query.fmt === 'text' ? '1' : JSON.stringify({ error: 'unknown group', on: 1 }));
  const on = tvOnNow(g.tv, new Date());
  if (req.query.fmt === 'text') return res.type('text/plain').send(on ? '1' : '0');
  res.json({ group: g.name, on: on ? 1 : 0, serverTime: new Date().toISOString(), tvEnabled: !!(g.tv && g.tv.enabled) });
});

app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));
app.use('/player', express.static(path.join(__dirname, 'public', 'player'), { maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/admin/'));

// --- admin side
function basicAuth(req, res, next) {
  const [scheme, enc] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && enc) {
    const [u, ...rest] = Buffer.from(enc, 'base64').toString().split(':');
    const p = rest.join(':');
    const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (same(u, ADMIN_USER) && same(p, ADMIN_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SC Signage", charset="UTF-8"');
  res.status(401).send('ต้องเข้าสู่ระบบ');
}

app.use('/admin', basicAuth, express.static(path.join(__dirname, 'public', 'admin'), { maxAge: 0 }));
const admin = express.Router();
admin.use(basicAuth);

admin.get('/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    rev: db.rev,
    layouts: LAYOUTS,
    assets: db.assets,
    playlists: db.playlists,
    groups: db.groups.map(groupStatus),
    players: db.players.map(playerPublic),
    settings: db.settings
  });
});

admin.get('/snapshot/:id', (req, res) => {
  const f = path.join(SNAP_DIR, cleanPlayerId(req.params.id) + '.jpg');
  res.set('Cache-Control', 'no-store');
  res.sendFile(f, (err) => { if (err) res.status(404).end(); });
});

// assets ---------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 8);
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype) || /\.zip$/i.test(file.originalname))
});

function extractHtmlZip(zipPath, id) {
  const zip = new AdmZip(zipPath);
  const dest = path.join(HTML_DIR, id);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/.test(e.entryName));
  if (!entries.length) throw new Error('zip ว่างเปล่า');
  // if everything sits in one top folder, strip it
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/')) ? [...tops][0] + '/' : '';
  for (const e of entries) {
    const rel = path.normalize(e.entryName.slice(strip.length));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('zip มีพาธไม่ปลอดภัย');
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData());
  }
  const htmls = entries.map((e) => e.entryName.slice(strip.length)).filter((n) => /\.html?$/i.test(n));
  const entry = htmls.find((n) => /^index\.html?$/i.test(n)) || htmls.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!entry) { fs.rmSync(dest, { recursive: true, force: true }); throw new Error('ไม่พบไฟล์ .html ใน zip'); }
  return entry.split('/').map(encodeURIComponent).join('/');
}

admin.post('/assets', upload.array('files', 50), (req, res) => {
  const added = [];
  const errors = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer decodes as latin1
    const base = { id: newId('a'), name, size: f.size, validFrom: '', validTo: '', createdAt: nowIso() };
    try {
      if (/\.zip$/i.test(name)) {
        const entry = extractHtmlZip(f.path, base.id);
        added.push({ ...base, type: 'html', entry });
      } else {
        added.push({ ...base, type: f.mimetype.startsWith('video/') ? 'video' : 'image', file: f.filename, mime: f.mimetype });
        continue;
      }
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
    fs.rm(f.path, { force: true }, () => {}); // the zip itself is not kept
  }
  db.assets.push(...added);
  if (added.length) commit();
  if (!added.length) return res.status(400).json({ error: errors.join(', ') || 'ไม่มีไฟล์ที่รองรับ (รูป, วิดีโอ, .zip)' });
  res.json({ added, errors });
});

admin.post('/assets/web', (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL ต้องขึ้นต้นด้วย http:// หรือ https://' });
  const a = { id: newId('a'), name: String(req.body.name || url).slice(0, 200), type: 'web', url, validFrom: '', validTo: '', createdAt: nowIso() };
  db.assets.push(a);
  commit();
  res.json(a);
});

admin.post('/assets/notice', (req, res) => {
  const notice = cleanNotice(req.body.notice);
  const a = { id: newId('a'), name: String(req.body.name || notice.title || 'ประกาศ').slice(0, 200), type: 'notice', notice, validFrom: '', validTo: '', createdAt: nowIso() };
  db.assets.push(a);
  commit();
  res.json(a);
});

admin.put('/assets/:id', (req, res) => {
  const a = assetById(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  if (typeof b.name === 'string') a.name = b.name.slice(0, 200);
  if (b.validFrom !== undefined) a.validFrom = dateOr(b.validFrom);
  if (b.validTo !== undefined) a.validTo = dateOr(b.validTo);
  if (a.type === 'web' && typeof b.url === 'string' && /^https?:\/\//i.test(b.url)) a.url = b.url.trim();
  if (a.type === 'notice' && b.notice) a.notice = cleanNotice(b.notice);
  commit();
  res.json(a);
});

admin.delete('/assets/:id', (req, res) => {
  const i = db.assets.findIndex((a) => a.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const [a] = db.assets.splice(i, 1);
  for (const p of db.playlists) {
    p.items = p.items.filter((it) => it.main !== a.id);
    for (const it of p.items) { if (it.side === a.id) it.side = ''; if (it.bottom === a.id) it.bottom = ''; }
  }
  for (const n of db.assets) if (n.type === 'notice' && n.notice && n.notice.image === a.id) n.notice.image = '';
  commit();
  collectGarbage(); // file stays while a deployed group still plays it
  res.json({ ok: true });
});

// playlists ------------------------------------------------------
admin.post('/playlists', (req, res) => {
  const p = { id: newId('p'), name: String(req.body.name || 'Playlist ใหม่').slice(0, 100), layout: LAYOUTS[req.body.layout] ? req.body.layout : '1', zoneAdjust: cleanZoneAdjust(req.body.zoneAdjust), ticker: cleanTicker(req.body.ticker), items: cleanItems(req.body.items) };
  db.playlists.push(p);
  commit();
  res.json(p);
});

admin.put('/playlists/:id', (req, res) => {
  const p = db.playlists.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  if (typeof b.name === 'string') p.name = b.name.slice(0, 100);
  if (b.layout !== undefined) p.layout = LAYOUTS[b.layout] ? b.layout : '1';
  if (b.zoneAdjust !== undefined) p.zoneAdjust = cleanZoneAdjust(b.zoneAdjust);
  if (b.ticker !== undefined) p.ticker = cleanTicker(b.ticker);
  if (Array.isArray(b.items)) p.items = cleanItems(b.items);
  commit();
  res.json(p);
});

admin.post('/playlists/:id/copy', (req, res) => {
  const p = db.playlists.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const c = JSON.parse(JSON.stringify(p));
  c.id = newId('p');
  c.name = p.name + ' (สำเนา)';
  db.playlists.push(c);
  commit();
  res.json(c);
});

admin.delete('/playlists/:id', (req, res) => {
  const i = db.playlists.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const [p] = db.playlists.splice(i, 1);
  for (const g of db.groups) {
    if (g.defaultPlaylist === p.id) g.defaultPlaylist = '';
    g.schedules = g.schedules.filter((s) => s.playlistId !== p.id);
  }
  if (db.settings.emergency.playlistId === p.id) db.settings.emergency.playlistId = '';
  commit();
  res.json({ ok: true });
});

// groups ---------------------------------------------------------
function applyGroup(g, b) {
  if (typeof b.name === 'string' && b.name.trim()) g.name = b.name.trim().slice(0, 100);
  if (b.orientation !== undefined) g.orientation = [0, 90, 180, 270].includes(Number(b.orientation)) ? Number(b.orientation) : 0;
  if (b.defaultPlaylist !== undefined) g.defaultPlaylist = db.playlists.some((p) => p.id === b.defaultPlaylist) ? b.defaultPlaylist : '';
  if (b.schedules !== undefined) g.schedules = cleanSchedules(b.schedules);
  if (b.tv !== undefined) g.tv = cleanTv(b.tv);
  if (Array.isArray(b.players)) {
    for (const pl of db.players) {
      if (b.players.includes(pl.id)) pl.groupId = g.id;
      else if (pl.groupId === g.id && g.id !== 'gdefault') pl.groupId = 'gdefault';
    }
  }
}

admin.post('/groups', (req, res) => {
  const g = { id: newId('g'), name: 'กลุ่มใหม่', ...groupDefaults() };
  applyGroup(g, req.body);
  db.groups.push(g);
  commit();
  res.json(groupStatus(g));
});

admin.put('/groups/:id', (req, res) => {
  const g = db.groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  applyGroup(g, req.body);
  if (req.body.deploy) { deployGroup(g); collectGarbage(); }
  commit();
  res.json(groupStatus(g));
});

admin.post('/groups/:id/deploy', (req, res) => {
  const targets = req.params.id === 'all' ? db.groups : db.groups.filter((g) => g.id === req.params.id);
  if (!targets.length) return res.status(404).json({ error: 'not found' });
  for (const g of targets) deployGroup(g);
  commit();
  collectGarbage();
  res.json({ ok: true, deployed: targets.length });
});

admin.delete('/groups/:id', (req, res) => {
  if (req.params.id === 'gdefault') return res.status(400).json({ error: 'ลบกลุ่มค่าเริ่มต้นไม่ได้' });
  const i = db.groups.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  if (db.players.some((p) => p.groupId === req.params.id)) return res.status(400).json({ error: 'ย้ายจอออกจากกลุ่มก่อนลบ' });
  db.groups.splice(i, 1);
  commit();
  collectGarbage();
  res.json({ ok: true });
});

// players --------------------------------------------------------
admin.put('/players/:id', (req, res) => {
  const pl = db.players.find((x) => x.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  if (typeof b.name === 'string' && b.name.trim()) pl.name = b.name.trim().slice(0, 100);
  if (typeof b.location === 'string') pl.location = b.location.slice(0, 200);
  if (b.groupId !== undefined && db.groups.some((g) => g.id === b.groupId)) pl.groupId = b.groupId;
  commit();
  res.json(playerPublic(pl));
});

// remote commands: reload page / request a screenshot
admin.post('/players/:id/:cmd(reload|snapshot)', (req, res) => {
  const ids = req.params.id === 'all' ? db.players.map((p) => p.id) : [req.params.id];
  const field = req.params.cmd === 'reload' ? 'reloadAt' : 'snapshotReq';
  for (const p of db.players) if (ids.includes(p.id)) p[field] = Date.now();
  commit();
  res.json({ ok: true });
});

admin.delete('/players/:id', (req, res) => {
  const i = db.players.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  db.players.splice(i, 1);
  fs.rm(path.join(SNAP_DIR, req.params.id.replace(/[^\w.-]/g, '') + '.jpg'), { force: true }, () => {});
  commit();
  res.json({ ok: true });
});

// settings (emergency takes effect immediately, no deploy needed) ----------
admin.put('/settings', (req, res) => {
  const e = req.body.emergency;
  if (e) {
    db.settings.emergency = {
      enabled: !!e.enabled,
      message: String(e.message || '').slice(0, 1000),
      playlistId: db.playlists.some((p) => p.id === e.playlistId) ? e.playlistId : ''
    };
  }
  commit();
  res.json(db.settings);
});

app.use('/api/admin', admin);

app.use((err, req, res, next) => {
  console.error(err.message);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  res.status(status).json({ error: status === 413 ? `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_MB} MB` : err.message });
});

// ---- รายการ IPv4 ของเครื่องในวง LAN ----
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---- mDNS: ประกาศชื่อ <MDNS_NAME>.local ให้เรียก server ด้วยชื่อแทน IP ----
// ESP32 และอุปกรณ์ที่รองรับ .local จะเรียก http://scsignage.local:PORT ได้โดยไม่ต้องรู้ IP
// (กล่อง Android 7 อาจแปลชื่อ .local ไม่ได้ ดู README)
const MDNS_NAME = (process.env.MDNS_NAME || 'scsignage').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'scsignage';
function startMdns() {
  let mdns;
  try { mdns = require('multicast-dns')(); }
  catch (e) { console.warn(`  ! mDNS ปิดอยู่ (ไม่พบแพ็กเกจ multicast-dns) — ใช้ IP แทน หรือรัน npm install`); return; }
  const host = MDNS_NAME + '.local';
  mdns.on('query', (query) => {
    const wants = query.questions.some((q) => q.name === host && (q.type === 'A' || q.type === 'ANY'));
    if (!wants) return;
    const answers = lanAddresses().map((ip) => ({ name: host, type: 'A', ttl: 120, data: ip }));
    if (answers.length) mdns.respond({ answers });
  });
  mdns.on('error', (e) => console.warn('  ! mDNS error:', e.message));
  console.log(`  ชื่อ  : http://${host}:${PORT}/  (mDNS — สำหรับ ESP32/อุปกรณ์ที่รองรับ .local)`);
}

const server = app.listen(PORT, () => {
  console.log(`SC Signage server on port ${PORT}`);
  const ips = lanAddresses();
  if (ips.length) for (const ip of ips) console.log(`  admin : http://${ip}:${PORT}/admin/  (user: ${ADMIN_USER})`);
  else console.log(`  admin : http://<server-ip>:${PORT}/admin/  (user: ${ADMIN_USER})`);
  console.log(`  player: /player/?id=<player-id>`);
  console.log(`  data  : ${DATA_DIR}`);
  startMdns();
  if (!process.env.ADMIN_PASS) console.warn('  ! using default admin password — set ADMIN_PASS');
});

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); writeDbNow(); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
