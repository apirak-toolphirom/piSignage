'use strict';
/*
 * UBU Signage server — local digital signage for LAN use.
 *   /admin   : management UI (basic auth)
 *   /player  : player page for screens (Android box app, or any browser)
 *   /media   : uploaded media files
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '2048', 10);
const ONLINE_WINDOW_MS = 90 * 1000;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- storage
const EMPTY_DB = {
  rev: 1,
  media: [],
  playlists: [],
  screens: [],
  settings: { tickerText: '', tickerEnabled: false, tickerSpeed: 80 }
};

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign({}, EMPTY_DB, db, { settings: Object.assign({}, EMPTY_DB.settings, db.settings) });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('db.json unreadable, starting fresh copy:', e.message);
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
}

let db = loadDb();
let saveTimer = null;

function writeDbNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// content change: bump rev so players rebuild, persist immediately
function commit() {
  db.rev += 1;
  writeDbNow();
}

// non-content change (heartbeats): persist lazily
function saveLater() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDbNow(); }, 15000);
}

const newId = (prefix) => prefix + crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- helpers
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanSchedules(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && db.playlists.some((p) => p.id === s.playlistId))
    .map((s) => ({
      playlistId: s.playlistId,
      days: Array.isArray(s.days) ? s.days.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6],
      start: TIME_RE.test(s.start) ? s.start : '00:00',
      end: TIME_RE.test(s.end) ? s.end : '23:59',
      dateFrom: DATE_RE.test(s.dateFrom || '') ? s.dateFrom : '',
      dateTo: DATE_RE.test(s.dateTo || '') ? s.dateTo : ''
    }));
}

function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && db.media.some((m) => m.id === it.mediaId))
    .map((it) => ({
      mediaId: it.mediaId,
      duration: Math.max(0, Math.min(3600, parseInt(it.duration, 10) || 0)),
      fit: it.fit === 'cover' ? 'cover' : 'contain',
      muted: !!it.muted
    }));
}

function screenPublic(s) {
  return Object.assign({}, s, { online: !!s.lastSeen && Date.now() - Date.parse(s.lastSeen) < ONLINE_WINDOW_MS });
}

function defaultDuration(type) {
  return type === 'video' ? 0 : type === 'web' ? 30 : 10;
}

// Build the self-contained config one screen needs to play offline.
function playerConfig(screen) {
  const used = new Set([screen.defaultPlaylist].concat(screen.schedules.map((s) => s.playlistId)));
  const playlists = {};
  for (const p of db.playlists) {
    if (!used.has(p.id)) continue;
    playlists[p.id] = p.items
      .map((it) => {
        const m = db.media.find((x) => x.id === it.mediaId);
        if (!m) return null;
        return {
          id: m.id,
          type: m.type,
          src: m.type === 'web' ? m.url : '/media/' + m.file,
          duration: it.duration || defaultDuration(m.type),
          fit: it.fit,
          muted: it.muted
        };
      })
      .filter(Boolean);
  }
  const s = db.settings;
  const useOwnTicker = !!screen.tickerText;
  return {
    rev: db.rev,
    serverTime: Date.now(),
    screen: { id: screen.id, name: screen.name, rotation: screen.rotation || 0, reloadAt: screen.reloadAt || 0 },
    defaultPlaylist: screen.defaultPlaylist || '',
    schedules: screen.schedules,
    playlists,
    ticker: {
      enabled: useOwnTicker || (s.tickerEnabled && !!s.tickerText),
      text: useOwnTicker ? screen.tickerText : s.tickerText,
      speed: s.tickerSpeed || 80
    }
  };
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// --- player side (no auth: screens on the LAN must reach it unattended)
app.get('/api/player/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^\w.-]/g, '').slice(0, 64);
  if (!id) return res.status(400).json({ error: 'bad id' });
  let screen = db.screens.find((s) => s.id === id);
  const preview = req.query.preview === '1';
  if (preview) {
    // admin preview: do not register or touch heartbeat
    if (!screen) return res.status(404).json({ error: 'unknown screen' });
    res.set('Cache-Control', 'no-store');
    return res.json(playerConfig(screen));
  }
  if (!screen) {
    screen = {
      id,
      name: 'จอใหม่ ' + id,
      group: '',
      location: '',
      rotation: 0,
      defaultPlaylist: db.playlists[0] ? db.playlists[0].id : '',
      schedules: [],
      tickerText: '',
      reloadAt: 0,
      createdAt: nowIso()
    };
    db.screens.push(screen);
    commit();
    console.log('new screen registered:', id);
  }
  screen.lastSeen = nowIso();
  screen.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  screen.agent = String(req.query.app || req.headers['user-agent'] || '').slice(0, 160);
  saveLater();
  res.set('Cache-Control', 'no-store');
  res.json(playerConfig(screen));
});

app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));
app.use('/player', express.static(path.join(__dirname, 'public', 'player'), { maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/admin'));

// --- admin side
function basicAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, enc] = h.split(' ');
  if (scheme === 'Basic' && enc) {
    const [u, ...rest] = Buffer.from(enc, 'base64').toString().split(':');
    const p = rest.join(':');
    const ok = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (ok(u, ADMIN_USER) && ok(p, ADMIN_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="UBU Signage", charset="UTF-8"');
  res.status(401).send('ต้องเข้าสู่ระบบ');
}

app.use('/admin', basicAuth, express.static(path.join(__dirname, 'public', 'admin'), { maxAge: 0 }));
const admin = express.Router();
admin.use(basicAuth);

admin.get('/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({}, db, { screens: db.screens.map(screenPublic) }));
});

// media
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 8);
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype))
});

admin.post('/media', upload.array('files', 50), (req, res) => {
  const added = (req.files || []).map((f) => {
    const m = {
      id: newId('m'),
      // multer gives latin1-decoded names; restore UTF-8 (Thai file names)
      name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      type: f.mimetype.startsWith('video/') ? 'video' : 'image',
      file: f.filename,
      mime: f.mimetype,
      size: f.size,
      createdAt: nowIso()
    };
    db.media.push(m);
    return m;
  });
  if (!added.length) return res.status(400).json({ error: 'ไม่มีไฟล์รูปหรือวิดีโอที่รองรับ' });
  commit();
  res.json(added);
});

admin.post('/media/web', (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL ต้องขึ้นต้นด้วย http:// หรือ https://' });
  const m = { id: newId('m'), name: String(req.body.name || url).slice(0, 200), type: 'web', url, createdAt: nowIso() };
  db.media.push(m);
  commit();
  res.json(m);
});

admin.patch('/media/:id', (req, res) => {
  const m = db.media.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string') m.name = req.body.name.slice(0, 200);
  commit();
  res.json(m);
});

admin.delete('/media/:id', (req, res) => {
  const i = db.media.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const [m] = db.media.splice(i, 1);
  for (const p of db.playlists) p.items = p.items.filter((it) => it.mediaId !== m.id);
  if (m.file) fs.unlink(path.join(MEDIA_DIR, m.file), () => {});
  commit();
  res.json({ ok: true });
});

// playlists
admin.post('/playlists', (req, res) => {
  const p = { id: newId('p'), name: String(req.body.name || 'Playlist ใหม่').slice(0, 100), items: cleanItems(req.body.items) };
  db.playlists.push(p);
  commit();
  res.json(p);
});

admin.put('/playlists/:id', (req, res) => {
  const p = db.playlists.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string') p.name = req.body.name.slice(0, 100);
  if (Array.isArray(req.body.items)) p.items = cleanItems(req.body.items);
  commit();
  res.json(p);
});

admin.delete('/playlists/:id', (req, res) => {
  const i = db.playlists.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const [p] = db.playlists.splice(i, 1);
  for (const s of db.screens) {
    if (s.defaultPlaylist === p.id) s.defaultPlaylist = '';
    s.schedules = s.schedules.filter((x) => x.playlistId !== p.id);
  }
  commit();
  res.json({ ok: true });
});

// screens
function applyScreenFields(s, b) {
  if (typeof b.name === 'string') s.name = b.name.slice(0, 100);
  if (typeof b.group === 'string') s.group = b.group.slice(0, 100);
  if (typeof b.location === 'string') s.location = b.location.slice(0, 200);
  if (typeof b.tickerText === 'string') s.tickerText = b.tickerText.slice(0, 1000);
  if (b.rotation !== undefined) s.rotation = [0, 90, 180, 270].includes(Number(b.rotation)) ? Number(b.rotation) : 0;
  if (b.defaultPlaylist !== undefined) {
    s.defaultPlaylist = db.playlists.some((p) => p.id === b.defaultPlaylist) ? b.defaultPlaylist : '';
  }
  if (b.schedules !== undefined) s.schedules = cleanSchedules(b.schedules);
}

admin.put('/screens/:id', (req, res) => {
  const s = db.screens.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  applyScreenFields(s, req.body);
  commit();
  res.json(screenPublic(s));
});

// copy playlist/schedule/ticker/rotation from one screen to others
admin.post('/screens/:id/copy', (req, res) => {
  const src = db.screens.find((x) => x.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  const targets = Array.isArray(req.body.targets) ? req.body.targets : [];
  let n = 0;
  for (const s of db.screens) {
    if (s.id === src.id || !targets.includes(s.id)) continue;
    s.defaultPlaylist = src.defaultPlaylist;
    s.schedules = JSON.parse(JSON.stringify(src.schedules));
    s.tickerText = src.tickerText;
    s.rotation = src.rotation;
    n++;
  }
  commit();
  res.json({ ok: true, updated: n });
});

admin.post('/screens/:id/reload', (req, res) => {
  const ids = req.params.id === 'all' ? db.screens.map((s) => s.id) : [req.params.id];
  for (const s of db.screens) if (ids.includes(s.id)) s.reloadAt = Date.now();
  commit();
  res.json({ ok: true });
});

admin.delete('/screens/:id', (req, res) => {
  const i = db.screens.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  db.screens.splice(i, 1);
  commit();
  res.json({ ok: true });
});

// settings
admin.put('/settings', (req, res) => {
  const s = db.settings;
  if (typeof req.body.tickerText === 'string') s.tickerText = req.body.tickerText.slice(0, 1000);
  if (req.body.tickerEnabled !== undefined) s.tickerEnabled = !!req.body.tickerEnabled;
  if (req.body.tickerSpeed !== undefined) s.tickerSpeed = Math.max(20, Math.min(400, parseInt(req.body.tickerSpeed, 10) || 80));
  commit();
  res.json(s);
});

app.use('/api/admin', admin);

app.use((err, req, res, next) => {
  console.error(err.message);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  res.status(status).json({ error: status === 413 ? `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_MB} MB` : err.message });
});

const server = app.listen(PORT, () => {
  console.log(`UBU Signage server on port ${PORT}`);
  console.log(`  admin : http://<server-ip>:${PORT}/admin  (user: ${ADMIN_USER})`);
  console.log(`  player: http://<server-ip>:${PORT}/player/?id=<screen-id>`);
  console.log(`  data  : ${DATA_DIR}`);
  if (!process.env.ADMIN_PASS) console.warn('  ! using default admin password — set ADMIN_PASS');
});

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); writeDbNow(); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
