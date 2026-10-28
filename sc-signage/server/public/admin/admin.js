'use strict';
/* SC Signage admin — piSignage-style flow: Assets → Playlists → Groups → Deploy */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const TYPE_TH = { image: 'รูป', video: 'วิดีโอ', web: 'เว็บ', html: 'HTML', notice: 'ประกาศ' };
const LAYOUT_TH = {
  '1': 'เต็มจอ', '2a': '2 โซน', '2b': '2 โซน', '2c': '2 โซนเท่ากัน', '2d': '2 โซนเท่ากัน',
  '3a': '3 โซน', '3b': '3 โซน', '3c': '3 โซน', '3d': '3 โซน', '4a': '3 โซน', '4b': '3 โซน', '4c': '3 โซน', '4d': '3 โซน',
  '2bp': 'แนวตั้ง 2 โซน'
};
const ORIENT_TH = { 0: 'แนวนอนปกติ', 90: '90° (แนวตั้ง)', 270: '270° (แนวตั้ง กลับด้าน)', 180: '180° (กลับหัว)' };

let S = { assets: [], playlists: [], groups: [], players: [], layouts: {}, settings: { emergency: {} } };
let editPl = null, plDirty = false;
let editGrp = null, grpDirty = false;

// ------------------------------------------------------------ api / helpers
async function api(method, url, body) {
  const r = await fetch('/api/admin' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast('ผิดพลาด: ' + e.message); }
}

const asset = (id) => S.assets.find((a) => a.id === id);
const plName = (id) => (S.playlists.find((p) => p.id === id) || {}).name || '— ไม่ได้เลือก —';
const grpById = (id) => S.groups.find((g) => g.id === id);
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round((b || 0) / 1024) + ' KB');
const today = () => new Date().toLocaleDateString('sv-SE');
const thDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

function validity(a) {
  const t = today();
  if (a.validTo && t > a.validTo) return '<span class="tag bad">หมดอายุ</span>';
  if (a.validFrom && t < a.validFrom) return `<span class="tag off">เริ่ม ${thDate(a.validFrom)}</span>`;
  if (a.validTo) return `<span class="tag">ถึง ${thDate(a.validTo)}</span>`;
  return '';
}

function noticeThumb(n) {
  n = n || {};
  const img = n.image && asset(n.image);
  const bg = img ? `background-image:linear-gradient(rgb(0 0 0/.45),rgb(0 0 0/.45)),url('/media/${esc(img.file)}');` : '';
  return `<div class="notice-thumb" style="background-color:${esc(n.bg)};color:${esc(n.color)};${bg}"><b>${esc(n.title)}</b><span>${esc((n.body || '').slice(0, 90))}</span></div>`;
}

function thumb(a, cls = 'thumb') {
  if (!a) return `<div class="${cls} web">?</div>`;
  if (a.type === 'image') return `<img class="${cls}" src="/media/${esc(a.file)}" loading="lazy" alt="">`;
  if (a.type === 'video') return `<video class="${cls}" src="/media/${esc(a.file)}#t=1" preload="metadata" muted></video>`;
  if (a.type === 'notice') return cls ? `<div class="${cls}" style="overflow:hidden">${noticeThumb(a.notice)}</div>` : noticeThumb(a.notice);
  return `<div class="${cls} web">${a.type === 'html' ? 'HTML' : 'WEB'}</div>`;
}

function timeAgo(iso) {
  if (!iso) return 'ยังไม่เคยเชื่อมต่อ';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return s + ' วินาทีที่แล้ว';
  if (s < 3600) return Math.round(s / 60) + ' นาทีที่แล้ว';
  if (s < 86400) return Math.round(s / 3600) + ' ชั่วโมงที่แล้ว';
  return new Date(iso).toLocaleString('th-TH');
}

function miniLayout(name) {
  const L = S.layouts[name] || {};
  const portrait = name.endsWith('p');
  return `<div class="mini ${portrait ? 'portrait' : ''}">${Object.keys(L).map((z) => {
    const [x, y, w, h] = L[z];
    return `<i class="z-${z}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"></i>`;
  }).join('')}</div>`;
}

function plOptions(sel, noneLabel) {
  return (noneLabel ? `<option value="">${noneLabel}</option>` : '') +
    S.playlists.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function daysHtml(sel) {
  return `<div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${sel.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>`;
}
const readDays = (el) => $$('.days input:checked', el).map((c) => Number(c.value));

async function refresh() {
  S = await api('GET', '/state');
  renderBanner();
  renderDashboard();
  renderAssets();
  renderPlaylistList();
  renderGroupList();
  renderSettings();
}

// ------------------------------------------------------------ tabs
function confirmLeave() {
  if ((plDirty || grpDirty) && !confirm('มีการแก้ไขที่ยังไม่บันทึก ออกเลยไหม?')) return false;
  plDirty = grpDirty = false;
  return true;
}
function showTab(name) {
  $$('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}
$$('nav button').forEach((b) => b.addEventListener('click', () => { if (confirmLeave()) { showTab(b.dataset.tab); refresh(); } }));

// ------------------------------------------------------------ banner (pending deploys, emergency)
function renderBanner() {
  const pending = S.groups.filter((g) => g.pendingChanges && (g.playerCount || g.deployed));
  const em = S.settings.emergency;
  let html = '';
  if (em.enabled) html += `<div class="alarm">⚠ กำลังแสดงประกาศฉุกเฉินบนทุกจอ <button class="ghost small" data-go="settings" style="color:#fff;border-color:#fff">จัดการ</button></div>`;
  if (pending.length) {
    html += `<div class="warn">มีการแก้ไขที่จอยังไม่ได้รับ: ${pending.map((g) => `<b>${esc(g.name)}</b>`).join(', ')}
      <button class="small" id="banner-deploy">Deploy ตอนนี้</button></div>`;
  }
  $('#banner').innerHTML = html;
  const bd = $('#banner-deploy');
  if (bd) bd.onclick = () => run(async () => { for (const g of pending) await api('POST', `/groups/${g.id}/deploy`); await refresh(); }, 'Deploy แล้ว จอจะอัปเดตภายใน ~20 วินาที');
  $$('#banner [data-go]').forEach((b) => (b.onclick = () => { if (confirmLeave()) showTab(b.dataset.go); }));
}

// ------------------------------------------------------------ dashboard
function renderDashboard() {
  const on = S.players.filter((p) => p.online).length;
  $('#stats').innerHTML = [
    [`${on}/${S.players.length}`, 'จอออนไลน์'],
    [S.groups.length, 'กลุ่ม'],
    [S.playlists.length, 'playlist'],
    [S.assets.length, 'asset']
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');

  const list = [...S.players].sort((a, b) => ((grpById(a.groupId) || {}).name || '').localeCompare((grpById(b.groupId) || {}).name || '', 'th') || a.name.localeCompare(b.name, 'th'));
  $('#player-list').innerHTML = list.length ? list.map((p) => {
    const g = grpById(p.groupId);
    const tv = p.playing && p.playing.tv === 'off';
    return `<div class="card player" data-id="${esc(p.id)}">
      <div class="shot">${p.snapshotAt ? `<img src="/api/admin/snapshot/${encodeURIComponent(p.id)}?t=${Date.parse(p.snapshotAt)}" alt=""><small>${timeAgo(p.snapshotAt)}</small>` : (p.agent === 'android' ? 'ยังไม่มีภาพหน้าจอ' : 'ภาพหน้าจอได้เฉพาะแอป Android')}</div>
      <div class="body">
        <h3 style="margin:0;font-size:16px;display:flex;gap:8px;align-items:center"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</h3>
        <div>${g ? `<span class="tag ${g.pendingChanges ? 'pending' : ''}">${esc(g.name)}</span>` : ''} ${tv ? '<span class="tag off">ปิดจอตามเวลา</span>' : ''} ${p.location ? `<span class="muted">${esc(p.location)}</span>` : ''}</div>
        <div class="meta">${p.online && p.playing && p.playing.playlist ? `▶ ${esc(p.playing.playlist)}${p.playing.asset ? ' · ' + esc(p.playing.asset) : ''}<br>` : ''}
          ${[esc(p.ip || ''), p.agent === 'android' ? 'Android' + (p.version ? ' ' + esc(p.version) : '') : esc(p.agent || ''), timeAgo(p.lastSeen)].filter(Boolean).join(' · ')}</div>
        <div class="actions">
          <button class="ghost small" data-act="edit">แก้ไข</button>
          ${p.agent === 'android' ? '<button class="ghost small" data-act="snapshot">ภาพหน้าจอ</button>' : ''}
          <button class="ghost small" data-act="reload">รีโหลด</button>
          <a class="small" href="/player/?id=${encodeURIComponent(p.id)}&preview=1" target="_blank">ดูตัวอย่าง ↗</a>
        </div>
      </div></div>`;
  }).join('') : '<p class="muted">ยังไม่มีจอเชื่อมต่อ</p>';

  $$('#player-list .card').forEach((c) => {
    const id = c.dataset.id;
    $$('[data-act]', c).forEach((b) => (b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'edit') return editPlayer(id);
      if (act === 'snapshot') return run(() => api('POST', `/players/${encodeURIComponent(id)}/snapshot`), 'ขอภาพหน้าจอแล้ว รอ ~30 วินาที');
      if (act === 'reload') return run(() => api('POST', `/players/${encodeURIComponent(id)}/reload`), 'ส่งคำสั่งรีโหลดแล้ว');
    }));
  });
}

function editPlayer(id) {
  const p = S.players.find((x) => x.id === id);
  const dlg = $('#dlg');
  dlg.innerHTML = `<form class="dlg">
    <h2>${esc(p.name)} <span class="muted">(${esc(p.id)})</span></h2>
    <label>ชื่อจอ <input name="name" value="${esc(p.name)}" required></label>
    <label>สถานที่ <input name="location" value="${esc(p.location)}" placeholder="เช่น ห้องประชุมชั้น 2"></label>
    <label>กลุ่ม <select name="groupId">${S.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === p.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <p class="hint">จอเล่นเนื้อหาที่ Deploy ล่าสุดของกลุ่ม — ย้ายกลุ่มแล้วจอจะเปลี่ยนเนื้อหาทันที</p>
    <div class="dlg-actions">
      <button type="button" class="danger" data-del>ลบจอ</button>
      <div><button type="button" class="ghost" data-close>ยกเลิก</button><button>บันทึก</button></div>
    </div></form>`;
  const f = $('form', dlg);
  f.onsubmit = (e) => {
    e.preventDefault();
    run(async () => { await api('PUT', '/players/' + encodeURIComponent(id), { name: f.name.value, location: f.location.value, groupId: f.groupId.value }); dlg.close(); await refresh(); }, 'บันทึกแล้ว');
  };
  $('[data-close]', dlg).onclick = () => dlg.close();
  $('[data-del]', dlg).onclick = () => {
    if (!confirm('ลบจอนี้? (ถ้ากล่องยังเปิดอยู่ จะลงทะเบียนกลับมาใหม่เองในกลุ่มค่าเริ่มต้น)')) return;
    run(async () => { await api('DELETE', '/players/' + encodeURIComponent(id)); dlg.close(); await refresh(); }, 'ลบแล้ว');
  };
  dlg.showModal();
}

$('#reload-all').onclick = () => run(() => api('POST', '/players/all/reload'), 'ส่งคำสั่งรีโหลดทุกจอแล้ว');
$('#snap-all').onclick = () => run(() => api('POST', '/players/all/snapshot'), 'ขอภาพหน้าจอแล้ว รอ ~30 วินาที');

// ------------------------------------------------------------ assets
function renderAssets() {
  const filter = $('#asset-filter').value;
  const list = [...S.assets].reverse().filter((a) => !filter || a.type === filter);
  $('#asset-count').textContent = `(${S.assets.length})`;
  $('#asset-grid').innerHTML = list.map((a) => `
    <div class="tile" data-id="${esc(a.id)}">
      <div class="pic">${a.type === 'video' ? `<video src="/media/${esc(a.file)}#t=1" preload="metadata" muted controls></video>` : thumb(a, '')}
        <div class="badges"><span class="tag">${TYPE_TH[a.type]}</span>${validity(a)}</div></div>
      <div class="body">
        <div class="name">${esc(a.name)}</div>
        <div class="muted">${a.type === 'web' ? esc(a.url) : a.type === 'notice' ? 'ประกาศข้อความ' : fmtSize(a.size)}</div>
        <div class="actions"><button class="ghost small" data-edit>แก้ไข</button><button class="danger small" data-del>ลบ</button></div>
      </div>
    </div>`).join('') || '<p class="muted">ยังไม่มี asset</p>';
  $$('#asset-grid .tile').forEach((t) => {
    const a = asset(t.dataset.id);
    $('[data-edit]', t).onclick = () => (a.type === 'notice' ? editNotice(a) : editAsset(a));
    $('[data-del]', t).onclick = () => {
      const n = S.playlists.filter((p) => p.items.some((it) => [it.main, it.side, it.bottom].includes(a.id))).length;
      if (!confirm(`ลบ "${a.name}"?${n ? `\nจะถูกเอาออกจาก ${n} playlist (จอที่ deploy ไปแล้วยังเล่นได้จนกว่าจะ deploy ใหม่)` : ''}`)) return;
      run(async () => { await api('DELETE', '/assets/' + a.id); await refresh(); }, 'ลบแล้ว');
    };
  });
}
$('#asset-filter').onchange = renderAssets;

function editAsset(a) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form class="dlg">
    <h2>แก้ไข ${TYPE_TH[a.type]}</h2>
    <label>ชื่อ <input name="name" value="${esc(a.name)}" required></label>
    ${a.type === 'web' ? `<label>URL <input name="url" value="${esc(a.url)}" required></label>` : ''}
    <div class="row">
      <label>แสดงตั้งแต่วันที่ <input type="date" name="validFrom" value="${esc(a.validFrom)}"></label>
      <label>หมดอายุหลังวันที่ <input type="date" name="validTo" value="${esc(a.validTo)}"></label>
    </div>
    <p class="hint">ช่วงวันที่ใช้งาน (เว้นว่าง = ตลอด) — นอกช่วงนี้จอจะข้าม asset นี้เอง ไม่ต้อง deploy ใหม่</p>
    <div class="dlg-actions"><span></span><div><button type="button" class="ghost" data-close>ยกเลิก</button><button>บันทึก</button></div></div>
  </form>`;
  const f = $('form', dlg);
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = { name: f.name.value, validFrom: f.validFrom.value, validTo: f.validTo.value };
    if (f.url) body.url = f.url.value;
    run(async () => { await api('PUT', '/assets/' + a.id, body); dlg.close(); await refresh(); }, 'บันทึกแล้ว');
  };
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.showModal();
}

const NOTICE_PRESETS = [['#e5761b', '#ffffff'], ['#1e3a8a', '#ffffff'], ['#0f766e', '#ffffff'], ['#111827', '#facc15'], ['#ffffff', '#111827']];

function editNotice(a) {
  const isNew = !a;
  a = a || { name: '', validFrom: '', validTo: '', notice: { title: '', body: '', footer: '', bg: '#e5761b', color: '#ffffff', image: '' } };
  const n = { ...a.notice };
  const images = S.assets.filter((x) => x.type === 'image');
  const dlg = $('#dlg');
  dlg.innerHTML = `<form class="dlg">
    <h2>${isNew ? 'สร้างประกาศ' : 'แก้ไขประกาศ'}</h2>
    <div class="notice-editor">
      <div class="stack">
        <label>หัวข้อ <input name="title" value="${esc(n.title)}" placeholder="เช่น ขอเชิญร่วมงานสัปดาห์วิทยาศาสตร์" required></label>
        <label>ข้อความ <textarea name="body" rows="4">${esc(n.body)}</textarea></label>
        <label>บรรทัดท้าย <input name="footer" value="${esc(n.footer)}" placeholder="เช่น วันที่ / สถานที่ / ผู้ประกาศ"></label>
        <div class="colors">
          <label>สีพื้น <input type="color" name="bg" value="${esc(n.bg)}"></label>
          <label>สีตัวอักษร <input type="color" name="color" value="${esc(n.color)}"></label>
        </div>
        <div class="btns">${NOTICE_PRESETS.map(([b, c]) => `<button type="button" class="small" data-preset="${b},${c}" style="background:${b};color:${c};border:1px solid var(--line)">Aa</button>`).join('')}</div>
        <label>รูปพื้นหลัง (ไม่บังคับ) <select name="image"><option value="">— ไม่มี —</option>${images.map((x) => `<option value="${x.id}" ${x.id === n.image ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      </div>
      <div class="stack">
        <div class="notice-preview" id="np"></div>
        <label>ชื่อ asset <input name="name" value="${esc(a.name)}" placeholder="(ใช้หัวข้อ)"></label>
        <div class="row">
          <label>แสดงตั้งแต่ <input type="date" name="validFrom" value="${esc(a.validFrom)}"></label>
          <label>หมดอายุหลัง <input type="date" name="validTo" value="${esc(a.validTo)}"></label>
        </div>
      </div>
    </div>
    <div class="dlg-actions"><span></span><div><button type="button" class="ghost" data-close>ยกเลิก</button><button>บันทึก</button></div></div>
  </form>`;
  const f = $('form', dlg);
  const read = () => ({ title: f.title.value, body: f.body.value, footer: f.footer.value, bg: f.bg.value, color: f.color.value, image: f.image.value });
  const preview = () => { $('#np').innerHTML = noticeThumb(read()); };
  f.oninput = preview;
  f.onchange = preview;
  $$('[data-preset]', f).forEach((b) => (b.onclick = () => { const [bg, c] = b.dataset.preset.split(','); f.bg.value = bg; f.color.value = c; preview(); }));
  preview();
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = { name: f.name.value || f.title.value, notice: read(), validFrom: f.validFrom.value, validTo: f.validTo.value };
    run(async () => {
      if (isNew) {
        const created = await api('POST', '/assets/notice', body);
        await api('PUT', '/assets/' + created.id, { validFrom: body.validFrom, validTo: body.validTo });
      } else await api('PUT', '/assets/' + a.id, body);
      dlg.close(); await refresh();
    }, 'บันทึกแล้ว');
  };
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.showModal();
}
$('#new-notice').onclick = () => editNotice(null);

function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append('files', f));
  const bar = $('#upload-progress');
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/assets');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = (e.loaded / e.total * 100) + '%'; };
  xhr.onload = async () => {
    bar.hidden = true; bar.firstElementChild.style.width = '0';
    let res = {}; try { res = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status >= 400) return toast('อัปโหลดไม่สำเร็จ: ' + (res.error || xhr.status));
    toast(`อัปโหลดแล้ว ${res.added.length} ไฟล์` + (res.errors.length ? ` (ผิดพลาด: ${res.errors.join(', ')})` : ''));
    await refresh();
  };
  xhr.onerror = () => { bar.hidden = true; toast('อัปโหลดไม่สำเร็จ'); };
  xhr.send(fd);
}
const drop = $('#drop');
$('#file-input').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
$('#web-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  run(async () => { await api('POST', '/assets/web', { name: f.name.value, url: f.url.value }); f.reset(); await refresh(); }, 'เพิ่มแล้ว');
};

// ------------------------------------------------------------ playlists
function usedBy(plId) {
  return S.groups.filter((g) => g.defaultPlaylist === plId || g.schedules.some((s) => s.playlistId === plId));
}

function renderPlaylistList() {
  $('#pl-list').innerHTML = S.playlists.map((p) => {
    const total = p.items.reduce((a, it) => a + (it.duration || 0), 0);
    const g = usedBy(p.id);
    return `<li data-id="${esc(p.id)}" class="${editPl && editPl.id === p.id ? 'active' : ''}">${esc(p.name)}
      <small>layout ${esc(p.layout)} · ${p.items.length} รายการ · ${total} วิ${g.length ? ' · ' + g.map((x) => esc(x.name)).join(', ') : ''}</small></li>`;
  }).join('') || '<li class="muted">ยังไม่มี playlist</li>';
  $$('#pl-list li[data-id]').forEach((li) => (li.onclick = () => { if (confirmLeave()) openPlaylist(li.dataset.id); }));
  if (editPl && !plDirty) {
    if (S.playlists.some((p) => p.id === editPl.id)) openPlaylist(editPl.id);
    else { editPl = null; $('#pl-editor').innerHTML = '<p class="muted">เลือกหรือสร้าง playlist</p>'; }
  }
}

function openPlaylist(id) {
  editPl = JSON.parse(JSON.stringify(S.playlists.find((p) => p.id === id)));
  plDirty = false;
  $$('#pl-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  drawPlaylist();
}

function zoneSelect(zone, value, i) {
  const opts = S.assets.filter((a) => a.type !== 'video' || zone !== 'bottom');
  return `<select data-zone="${zone}" data-i="${i}" title="โซน ${zone}">
    <option value="">${zone === 'side' ? 'โซนข้าง: —' : 'โซนล่าง: —'}</option>
    ${opts.map((a) => `<option value="${a.id}" ${a.id === value ? 'selected' : ''}>${zone === 'side' ? 'ข้าง' : 'ล่าง'}: ${esc(a.name)}</option>`).join('')}
  </select>`;
}

function drawPlaylist() {
  const p = editPl;
  const L = S.layouts[p.layout] || {};
  const total = p.items.reduce((a, it) => a + (it.duration || 0), 0);
  const groups = usedBy(p.id);
  $('#pl-editor').innerHTML = `
    <div class="bar">
      <input id="pl-name" value="${esc(p.name)}" style="max-width:340px">
      <div class="btns">
        <button class="ghost" id="pl-copy">ทำสำเนา</button>
        <button class="danger" id="pl-del">ลบ</button>
        <button id="pl-save">บันทึก${plDirty ? ' *' : ''}</button>
      </div>
    </div>
    <p class="hint">${groups.length ? `ใช้ในกลุ่ม: ${groups.map((g) => esc(g.name)).join(', ')} — บันทึกแล้วต้องกด <b>Deploy</b> ที่กลุ่มเพื่อส่งไปจอ` : 'ยังไม่ได้ใช้ในกลุ่มใด — ไปที่แท็บ Groups เพื่อเลือก playlist ให้กลุ่ม'}</p>

    <div class="section">
      <div class="bar"><strong>Layout</strong><span><span class="zone-key"><i class="z-main"></i>main</span><span class="zone-key"><i class="z-side"></i>side</span><span class="zone-key"><i class="z-bottom"></i>bottom</span></span></div>
      <div class="layouts">${Object.keys(S.layouts).map((k) => `<div class="layout-opt ${k === p.layout ? 'active' : ''}" data-layout="${k}">${miniLayout(k)}${k} · ${LAYOUT_TH[k] || ''}</div>`).join('')}</div>
    </div>

    <div class="section">
      <div class="bar"><strong>รายการ (${p.items.length}) · ประมาณ ${total} วินาที</strong>
        ${L.side || L.bottom ? '<button class="ghost small" id="zone-all">ใช้โซนข้าง/ล่างของแถวแรกกับทุกแถว</button>' : ''}</div>
      <p class="hint">โซน main กำหนดเวลา — ระยะเวลา 0 กับวิดีโอ = เล่นจนจบ${L.side || L.bottom ? ' · โซนข้าง/ล่างเปลี่ยนตามแต่ละแถว (เลือกซ้ำกัน = แสดงค้างไว้)' : ''}</p>
      <div class="rows">${p.items.map((it, i) => {
        const m = asset(it.main);
        return `<div class="row-item" data-i="${i}">
          <span class="num">${i + 1}</span>${thumb(m)}
          <div><div class="main-name">${esc(m ? m.name : '(ถูกลบ)')} ${m ? validity(m) : ''}</div>
            ${L.side || L.bottom ? `<div class="zones">${L.side ? zoneSelect('side', it.side, i) : ''}${L.bottom ? zoneSelect('bottom', it.bottom, i) : ''}</div>` : ''}</div>
          <span class="opts">
            <input type="number" min="0" max="3600" value="${it.duration}" title="วินาที" data-k="duration">วิ
            <select data-k="fit" title="การจัดภาพ">
              <option value="contain" ${it.fit !== 'cover' ? 'selected' : ''}>พอดีโซน</option>
              <option value="cover" ${it.fit === 'cover' ? 'selected' : ''}>เต็มโซน</option>
            </select>
            ${m && m.type === 'video' ? `<label class="check"><input type="checkbox" data-k="muted" ${it.muted ? 'checked' : ''}>ปิดเสียง</label>` : ''}
            <button class="ghost small" data-mv="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="ghost small" data-mv="1" ${i === p.items.length - 1 ? 'disabled' : ''}>▼</button>
            <button class="danger small" data-rm>✕</button>
          </span></div>`;
      }).join('') || '<p class="muted">ยังไม่มีรายการ — กด asset ด้านล่างเพื่อเพิ่ม</p>'}</div>
      <strong>เพิ่ม asset ลงโซน main (กดเพื่อเพิ่มท้าย)</strong>
      <div class="grid picker">${S.assets.map((a) => `
        <div class="tile" data-aid="${esc(a.id)}"><div class="pic">${thumb(a, '')}<div class="badges"><span class="tag">${TYPE_TH[a.type]}</span></div></div>
        <div class="body"><div class="name">${esc(a.name)}</div></div></div>`).join('') || '<p class="muted">ยังไม่มี asset</p>'}</div>
    </div>

    <div class="section">
      <strong>ข้อความวิ่ง (Ticker) ของ playlist นี้</strong>
      <textarea id="tk-text" rows="2" placeholder="ขึ้นบรรทัดใหม่ = ข้อความถัดไป">${esc(p.ticker.text)}</textarea>
      <div class="btns" style="align-items:center">
        <label class="check"><input type="checkbox" id="tk-on" ${p.ticker.enabled ? 'checked' : ''}> แสดงข้อความวิ่ง</label>
        <label style="display:flex;gap:6px;align-items:center">ความเร็ว <input type="number" id="tk-speed" min="20" max="400" value="${p.ticker.speed}" style="width:80px"> px/วิ</label>
      </div>
    </div>`;

  const dirty = () => { plDirty = true; $('#pl-save').textContent = 'บันทึก *'; };
  const redraw = () => { plDirty = true; drawPlaylist(); };
  $('#pl-name').oninput = (e) => { p.name = e.target.value; dirty(); };
  $$('[data-layout]').forEach((d) => (d.onclick = () => { p.layout = d.dataset.layout; redraw(); }));
  $$('#pl-editor .row-item').forEach((row) => {
    const i = Number(row.dataset.i);
    $$('[data-k]', row).forEach((inp) => (inp.onchange = () => {
      const k = inp.dataset.k;
      p.items[i][k] = k === 'duration' ? Number(inp.value) : k === 'muted' ? inp.checked : inp.value;
      dirty();
    }));
    $$('[data-zone]', row).forEach((sel) => (sel.onchange = () => { p.items[i][sel.dataset.zone] = sel.value; dirty(); }));
    $$('[data-mv]', row).forEach((b) => (b.onclick = () => {
      const j = i + Number(b.dataset.mv);
      [p.items[i], p.items[j]] = [p.items[j], p.items[i]];
      redraw();
    }));
    $('[data-rm]', row).onclick = () => { p.items.splice(i, 1); redraw(); };
  });
  const za = $('#zone-all');
  if (za) za.onclick = () => { if (!p.items.length) return; const f = p.items[0]; p.items.forEach((it) => { it.side = f.side; it.bottom = f.bottom; }); redraw(); };
  $$('#pl-editor .picker .tile').forEach((t) => (t.onclick = () => {
    const a = asset(t.dataset.aid);
    const prev = p.items[p.items.length - 1];
    p.items.push({ main: a.id, side: prev ? prev.side : '', bottom: prev ? prev.bottom : '', duration: a.type === 'video' ? 0 : a.type === 'web' || a.type === 'html' ? 30 : 10, fit: 'contain', muted: false });
    redraw();
  }));
  $('#tk-text').oninput = (e) => { p.ticker.text = e.target.value; dirty(); };
  $('#tk-on').onchange = (e) => { p.ticker.enabled = e.target.checked; dirty(); };
  $('#tk-speed').onchange = (e) => { p.ticker.speed = Number(e.target.value); dirty(); };
  $('#pl-save').onclick = () => run(async () => {
    await api('PUT', '/playlists/' + p.id, { name: p.name, layout: p.layout, ticker: p.ticker, items: p.items });
    plDirty = false; await refresh();
  }, groups.length ? 'บันทึกแล้ว — อย่าลืม Deploy กลุ่มที่ใช้ playlist นี้' : 'บันทึกแล้ว');
  $('#pl-copy').onclick = () => { if (confirmLeave()) run(async () => { const c = await api('POST', `/playlists/${p.id}/copy`); await refresh(); openPlaylist(c.id); }, 'ทำสำเนาแล้ว'); };
  $('#pl-del').onclick = () => {
    if (!confirm(`ลบ playlist "${p.name}"?${groups.length ? '\nกลุ่มที่ใช้อยู่จะไม่มี playlist นี้หลัง deploy ครั้งถัดไป' : ''}`)) return;
    run(async () => { await api('DELETE', '/playlists/' + p.id); editPl = null; plDirty = false; await refresh(); }, 'ลบแล้ว');
  };
}

$('#pl-new').onclick = () => {
  if (!confirmLeave()) return;
  const name = prompt('ชื่อ playlist', 'ประชาสัมพันธ์ทั่วไป');
  if (!name) return;
  run(async () => { const p = await api('POST', '/playlists', { name }); await refresh(); openPlaylist(p.id); }, 'สร้างแล้ว');
};

// ------------------------------------------------------------ groups
function renderGroupList() {
  $('#grp-list').innerHTML = S.groups.map((g) => `<li data-id="${esc(g.id)}" class="${editGrp && editGrp.id === g.id ? 'active' : ''}">
    ${esc(g.name)} ${g.pendingChanges ? '<span class="tag pending">รอ deploy</span>' : g.deployed ? '<span class="tag ok">ล่าสุด</span>' : ''}
    <small>${g.playerCount} จอ · ${esc(plName(g.defaultPlaylist))}${g.schedules.length ? ` + ตาราง ${g.schedules.length}` : ''}</small></li>`).join('');
  $$('#grp-list li[data-id]').forEach((li) => (li.onclick = () => { if (confirmLeave()) openGroup(li.dataset.id); }));
  if (editGrp && !grpDirty) {
    if (grpById(editGrp.id)) openGroup(editGrp.id);
    else { editGrp = null; $('#grp-editor').innerHTML = '<p class="muted">เลือกกลุ่ม</p>'; }
  }
}

function openGroup(id) {
  const g = grpById(id);
  editGrp = JSON.parse(JSON.stringify(g));
  editGrp.players = S.players.filter((p) => p.groupId === id).map((p) => p.id);
  grpDirty = false;
  $$('#grp-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  drawGroup();
}

function schedRow(s) {
  return `<div class="sched" data-row="sched">
    <label>Playlist <select data-k="playlistId">${plOptions(s.playlistId)}</select></label>
    ${daysHtml(s.days)}
    <div class="times">
      <label>เริ่ม <input type="time" data-k="start" value="${esc(s.start)}"></label>
      <label>ถึง <input type="time" data-k="end" value="${esc(s.end)}"></label>
      <label>ตั้งแต่วันที่ <input type="date" data-k="dateFrom" value="${esc(s.dateFrom)}"></label>
      <label>ถึงวันที่ <input type="date" data-k="dateTo" value="${esc(s.dateTo)}"></label>
      <button type="button" class="danger small" data-rmrow>ลบ</button>
    </div></div>`;
}

function tvRow(r) {
  return `<div class="sched" data-row="tv">
    ${daysHtml(r.days)}
    <div class="times">
      <label>เปิดจอ <input type="time" data-k="on" value="${esc(r.on)}"></label>
      <label>ปิดจอ <input type="time" data-k="off" value="${esc(r.off)}"></label>
      <label>เฉพาะวันที่ (ไม่บังคับ) <input type="date" data-k="dateFrom" value="${esc(r.dateFrom)}"></label>
      <label>ถึงวันที่ <input type="date" data-k="dateTo" value="${esc(r.dateTo)}"></label>
      <button type="button" class="danger small" data-rmrow>ลบ</button>
    </div></div>`;
}

function readRows(kind) {
  return $$(`[data-row="${kind}"]`, $('#grp-editor')).map((el) => {
    const o = { days: readDays(el) };
    $$('[data-k]', el).forEach((i) => (o[i.dataset.k] = i.value));
    return o;
  });
}

function drawGroup() {
  const g = editGrp;
  const status = g.pendingChanges ? '<span class="tag pending">มีการแก้ไขที่ยังไม่ deploy</span>'
    : g.deployed ? `<span class="tag ok">Deploy แล้ว ${new Date(g.deployed.at).toLocaleString('th-TH')}</span>` : '<span class="tag off">ยังไม่เคย deploy</span>';
  $('#grp-editor').innerHTML = `
    <div class="bar">
      <input id="g-name" value="${esc(g.name)}" style="max-width:300px" ${g.id === 'gdefault' ? 'title="กลุ่มที่จอใหม่จะเข้าก่อน"' : ''}>
      <div class="btns">
        ${g.id !== 'gdefault' ? '<button class="danger" id="g-del">ลบ</button>' : ''}
        <button class="ghost" id="g-save">บันทึก</button>
        <button id="g-deploy">บันทึกและ Deploy</button>
      </div>
    </div>
    <div>${status}</div>

    <div class="section">
      <div class="row">
        <label>Playlist หลัก (เล่นเมื่อไม่ตรงกับตารางเวลา) <select data-f="defaultPlaylist">${plOptions(g.defaultPlaylist, '— ไม่เล่นอะไร —')}</select></label>
        <label>การหมุนจอ <select data-f="orientation">${[0, 90, 270, 180].map((r) => `<option value="${r}" ${r === g.orientation ? 'selected' : ''}>${ORIENT_TH[r]}</option>`).join('')}</select></label>
      </div>
    </div>

    <div class="section">
      <div class="bar"><strong>ตารางเวลา playlist <span class="muted">(รายการบนสุดมีสิทธิ์ก่อน)</span></strong>
        <button type="button" class="ghost small" id="add-sched" ${S.playlists.length ? '' : 'disabled'}>+ เพิ่มช่วงเวลา</button></div>
      <div class="items" id="sched-rows">${g.schedules.map(schedRow).join('')}</div>
    </div>

    <div class="section">
      <div class="bar"><strong>เปิด/ปิดจอตามเวลา (TV on/off)</strong>
        <label class="check"><input type="checkbox" id="tv-on" ${g.tv.enabled ? 'checked' : ''}> ใช้งาน</label></div>
      <p class="hint">นอกช่วงเวลาที่ตั้ง จอจะดำและหยุดเล่น (แอป Android ลดแสงหน้าจอลง) · แถวที่ระบุวันที่ใช้แทนแถวรายสัปดาห์ในวันนั้น เช่น วันหยุดพิเศษ</p>
      <div class="items" id="tv-rows">${g.tv.rows.map(tvRow).join('')}</div>
      <div><button type="button" class="ghost small" id="add-tv">+ เพิ่มช่วงเปิดจอ</button></div>
    </div>

    <div class="section">
      <strong>จอในกลุ่มนี้ (${g.players.length})</strong>
      <div class="checks">${S.players.map((p) => {
        const other = p.groupId !== g.id ? grpById(p.groupId) : null;
        return `<label><input type="checkbox" value="${esc(p.id)}" data-player ${g.players.includes(p.id) ? 'checked' : ''}>
          <span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)} ${other ? `<span class="muted">(${esc(other.name)})</span>` : ''}</label>`;
      }).join('') || '<span class="muted">ยังไม่มีจอ</span>'}</div>
      ${g.id !== 'gdefault' ? '<p class="hint">เอาเครื่องหมายออก = ย้ายจอกลับกลุ่ม "ค่าเริ่มต้น"</p>' : ''}
    </div>`;

  const ed = $('#grp-editor');
  const dirty = () => { grpDirty = true; };
  ed.oninput = dirty;
  ed.onchange = dirty;
  const bindRm = () => $$('[data-rmrow]', ed).forEach((b) => (b.onclick = () => { b.closest('.sched').remove(); dirty(); }));
  bindRm();
  $('#add-sched').onclick = () => {
    $('#sched-rows').insertAdjacentHTML('beforeend', schedRow({ playlistId: S.playlists[0].id, days: [1, 2, 3, 4, 5], start: '08:00', end: '16:30', dateFrom: '', dateTo: '' }));
    bindRm(); dirty();
  };
  $('#add-tv').onclick = () => {
    $('#tv-rows').insertAdjacentHTML('beforeend', tvRow({ days: [1, 2, 3, 4, 5], on: '07:30', off: '17:30', dateFrom: '', dateTo: '' }));
    bindRm(); dirty();
  };

  const collect = () => ({
    name: $('#g-name').value,
    defaultPlaylist: $('[data-f=defaultPlaylist]', ed).value,
    orientation: Number($('[data-f=orientation]', ed).value),
    schedules: readRows('sched'),
    tv: { enabled: $('#tv-on').checked, rows: readRows('tv') },
    players: $$('[data-player]:checked', ed).map((c) => c.value)
  });
  const save = (deploy) => run(async () => {
    const body = collect();
    if (body.tv.enabled && !body.tv.rows.length) throw new Error('เปิดใช้ TV on/off แล้ว ต้องมีช่วงเปิดจออย่างน้อย 1 แถว');
    await api('PUT', '/groups/' + g.id, { ...body, deploy });
    grpDirty = false; await refresh();
  }, deploy ? 'Deploy แล้ว จอจะอัปเดตภายใน ~20 วินาที' : 'บันทึกแล้ว (ยังไม่ส่งไปจอ)');
  $('#g-save').onclick = () => save(false);
  $('#g-deploy').onclick = () => save(true);
  const del = $('#g-del');
  if (del) del.onclick = () => {
    if (!confirm(`ลบกลุ่ม "${g.name}"?`)) return;
    run(async () => { await api('DELETE', '/groups/' + g.id); editGrp = null; grpDirty = false; await refresh(); }, 'ลบแล้ว');
  };
}

$('#grp-new').onclick = () => {
  if (!confirmLeave()) return;
  const name = prompt('ชื่อกลุ่ม เช่น ห้องประชุม, ห้องเรียน', 'ห้องประชุม');
  if (!name) return;
  run(async () => { const g = await api('POST', '/groups', { name }); await refresh(); openGroup(g.id); }, 'สร้างแล้ว');
};
$('#deploy-all').onclick = () => { if (confirmLeave()) run(async () => { await api('POST', '/groups/all/deploy'); await refresh(); }, 'Deploy ทุกกลุ่มแล้ว'); };

// ------------------------------------------------------------ settings / emergency
function renderSettings() {
  const f = $('#emergency-form');
  const em = S.settings.emergency;
  if (!(document.activeElement && f.contains(document.activeElement))) {
    f.message.value = em.message || '';
    f.enabled.checked = !!em.enabled;
  }
  f.playlistId.innerHTML = plOptions(em.playlistId, '— ใช้ข้อความด้านบน —');
  $('#server-url').textContent = location.origin;
  $('#browser-url').textContent = location.origin + '/player/?id=ชื่อจอ';
}
$('#emergency-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.enabled.checked && !f.message.value.trim() && !f.playlistId.value) return toast('ใส่ข้อความหรือเลือก playlist ก่อน');
  if (f.enabled.checked && !confirm('เปิดประกาศฉุกเฉินบนทุกจอทันที?')) return;
  run(async () => {
    await api('PUT', '/settings', { emergency: { enabled: f.enabled.checked, message: f.message.value, playlistId: f.playlistId.value } });
    await refresh();
  }, f.enabled.checked ? 'เปิดประกาศฉุกเฉินแล้ว' : 'บันทึกแล้ว');
};

// ------------------------------------------------------------ boot
refresh().catch((e) => toast('โหลดข้อมูลไม่ได้: ' + e.message));
setInterval(() => {
  if ($('#dlg').open || plDirty || grpDirty || document.hidden) return;
  if (!$('#tab-dashboard').classList.contains('active')) return;
  api('GET', '/state').then((s) => { S = s; renderBanner(); renderDashboard(); }).catch(() => {});
}, 15000);
