'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

let state = { media: [], playlists: [], screens: [], settings: {} };
let currentPl = null;    // playlist being edited (working copy)
let plDirty = false;

// ------------------------------------------------------------ api
async function api(method, url, body) {
  const r = await fetch('/api/admin' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function refresh() {
  state = await api('GET', '/state');
  renderScreens();
  renderPlaylistList();
  renderMedia();
  renderSettings();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { toast('ผิดพลาด: ' + e.message); }
}

const mediaById = (id) => state.media.find((m) => m.id === id);
const plName = (id) => (state.playlists.find((p) => p.id === id) || {}).name || '— ไม่ได้เลือก —';
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

function thumb(m, cls = 'thumb') {
  if (!m) return `<div class="${cls} web">?</div>`;
  if (m.type === 'image') return `<img class="${cls}" src="/media/${esc(m.file)}" loading="lazy" alt="">`;
  if (m.type === 'video') return `<video class="${cls}" src="/media/${esc(m.file)}#t=1" preload="metadata" muted></video>`;
  return `<div class="${cls} web">WEB</div>`;
}

function timeAgo(iso) {
  if (!iso) return 'ยังไม่เคยเชื่อมต่อ';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return s + ' วินาทีที่แล้ว';
  if (s < 3600) return Math.round(s / 60) + ' นาทีที่แล้ว';
  if (s < 86400) return Math.round(s / 3600) + ' ชั่วโมงที่แล้ว';
  return new Date(iso).toLocaleString('th-TH');
}

// ------------------------------------------------------------ tabs
$$('nav button').forEach((b) => b.addEventListener('click', () => {
  if (plDirty && !confirm('playlist ยังไม่ได้บันทึก ออกเลยไหม?')) return;
  $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
}));

// ------------------------------------------------------------ screens
function renderScreens() {
  const list = [...state.screens].sort((a, b) => (a.group || '').localeCompare(b.group || '', 'th') || a.name.localeCompare(b.name, 'th'));
  const on = list.filter((s) => s.online).length;
  $('#screen-count').textContent = `(ออนไลน์ ${on}/${list.length})`;
  $('#screen-list').innerHTML = list.length ? list.map((s) => `
    <div class="card" data-id="${esc(s.id)}">
      <h3><span class="dot ${s.online ? 'on' : ''}"></span>${esc(s.name)}</h3>
      <div class="meta">
        ${s.group ? `<span class="tag">${esc(s.group)}</span> ` : ''}${esc(s.location)}<br>
        Playlist: <b>${esc(plName(s.defaultPlaylist))}</b>${s.schedules.length ? ` + ตารางเวลา ${s.schedules.length} รายการ` : ''}<br>
        ${esc(s.ip || '')} · ${timeAgo(s.lastSeen)}
      </div>
    </div>`).join('') : '<p class="muted">ยังไม่มีจอเชื่อมต่อ</p>';
  $$('#screen-list .card').forEach((c) => c.addEventListener('click', () => openScreen(c.dataset.id)));
}

function plOptions(sel, allowNone) {
  return (allowNone ? `<option value="">— ไม่เล่นอะไร —</option>` : '') +
    state.playlists.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function schedHtml(s) {
  return `<div class="sched">
    <label>Playlist <select data-k="playlistId">${plOptions(s.playlistId)}</select></label>
    <div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${s.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
    <div class="times">
      <label>เริ่ม <input type="time" data-k="start" value="${esc(s.start)}"></label>
      <label>ถึง <input type="time" data-k="end" value="${esc(s.end)}"></label>
      <label>ตั้งแต่วันที่ <input type="date" data-k="dateFrom" value="${esc(s.dateFrom)}"></label>
      <label>ถึงวันที่ <input type="date" data-k="dateTo" value="${esc(s.dateTo)}"></label>
      <button type="button" class="danger small" data-del>ลบ</button>
    </div>
  </div>`;
}

function openScreen(id) {
  const s = state.screens.find((x) => x.id === id);
  if (!s) return;
  const dlg = $('#screen-dialog');
  const sameGroup = state.screens.filter((x) => x.id !== s.id && s.group && x.group === s.group);
  dlg.innerHTML = `<form class="dlg" method="dialog">
    <div class="bar"><h2>${esc(s.name)} <span class="muted">(${esc(s.id)})</span></h2>
      <a href="/player/?id=${encodeURIComponent(s.id)}&preview=1" target="_blank">ดูตัวอย่าง ↗</a></div>
    <div class="row">
      <label>ชื่อจอ <input name="name" value="${esc(s.name)}"></label>
      <label>กลุ่ม (เช่น ห้องประชุม, ห้องเรียน) <input name="group" value="${esc(s.group)}" list="groups"></label>
    </div>
    <datalist id="groups">${[...new Set(state.screens.map((x) => x.group).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    <div class="row">
      <label>สถานที่ <input name="location" value="${esc(s.location)}"></label>
      <label>การหมุนจอ <select name="rotation">
        ${[0, 90, 180, 270].map((r) => `<option value="${r}" ${r === (s.rotation || 0) ? 'selected' : ''}>${r === 0 ? 'แนวนอนปกติ' : r === 90 ? '90° (แนวตั้ง)' : r === 270 ? '270° (แนวตั้ง กลับด้าน)' : '180° (กลับหัว)'}</option>`).join('')}
      </select></label>
    </div>
    <label>Playlist หลัก (เล่นเมื่อไม่ตรงกับตารางเวลา) <select name="defaultPlaylist">${plOptions(s.defaultPlaylist, true)}</select></label>
    <div>
      <div class="bar"><strong>ตารางเวลา <span class="muted">(รายการบนสุดมีสิทธิ์ก่อน)</span></strong>
        <button type="button" class="ghost small" id="add-sched" ${state.playlists.length ? '' : 'disabled'}>+ เพิ่มช่วงเวลา</button></div>
      <div id="sched-list" class="items">${s.schedules.map(schedHtml).join('')}</div>
    </div>
    <label>ข้อความวิ่งเฉพาะจอนี้ (เว้นว่าง = ใช้ข้อความรวม) <textarea name="tickerText" rows="2">${esc(s.tickerText)}</textarea></label>
    <div class="dlg-actions">
      <div>
        <button type="button" class="danger" id="del-screen">ลบจอ</button>
        <button type="button" class="ghost" id="reload-screen">สั่งรีโหลด</button>
        ${sameGroup.length ? `<button type="button" class="ghost" id="copy-group">คัดลอกค่าไปจออื่นในกลุ่ม (${sameGroup.length})</button>` : ''}
      </div>
      <div>
        <button type="button" class="ghost" id="close-dlg">ปิด</button>
        <button type="submit" id="save-screen">บันทึก</button>
      </div>
    </div>
  </form>`;

  const schedList = $('#sched-list', dlg);
  const bindDel = () => $$('[data-del]', schedList).forEach((b) => (b.onclick = () => b.closest('.sched').remove()));
  bindDel();
  $('#add-sched', dlg).onclick = () => {
    schedList.insertAdjacentHTML('beforeend', schedHtml({ playlistId: state.playlists[0].id, days: [1, 2, 3, 4, 5], start: '08:00', end: '16:30', dateFrom: '', dateTo: '' }));
    bindDel();
  };

  const collect = () => {
    const f = $('form', dlg);
    return {
      name: f.name.value, group: f.group.value.trim(), location: f.location.value,
      rotation: Number(f.rotation.value), defaultPlaylist: f.defaultPlaylist.value, tickerText: f.tickerText.value,
      schedules: $$('.sched', schedList).map((el) => ({
        playlistId: $('[data-k=playlistId]', el).value,
        days: $$('.days input:checked', el).map((c) => Number(c.value)),
        start: $('[data-k=start]', el).value || '00:00',
        end: $('[data-k=end]', el).value || '23:59',
        dateFrom: $('[data-k=dateFrom]', el).value,
        dateTo: $('[data-k=dateTo]', el).value
      }))
    };
  };

  $('form', dlg).onsubmit = (e) => {
    e.preventDefault();
    run(async () => { await api('PUT', '/screens/' + encodeURIComponent(id), collect()); dlg.close(); await refresh(); }, 'บันทึกแล้ว จอจะอัปเดตภายใน ~20 วินาที');
  };
  $('#close-dlg', dlg).onclick = () => dlg.close();
  $('#reload-screen', dlg).onclick = () => run(() => api('POST', '/screens/' + encodeURIComponent(id) + '/reload'), 'ส่งคำสั่งรีโหลดแล้ว');
  $('#del-screen', dlg).onclick = () => {
    if (!confirm('ลบจอนี้? (ถ้ากล่องยังเปิดอยู่ จะลงทะเบียนกลับมาใหม่เอง)')) return;
    run(async () => { await api('DELETE', '/screens/' + encodeURIComponent(id)); dlg.close(); await refresh(); }, 'ลบแล้ว');
  };
  const cg = $('#copy-group', dlg);
  if (cg) cg.onclick = () => {
    if (!confirm(`บันทึกจอนี้ แล้วคัดลอก playlist/ตารางเวลา/ข้อความวิ่ง/การหมุน ไปยังจอกลุ่ม "${s.group}" อีก ${sameGroup.length} จอ?`)) return;
    run(async () => {
      await api('PUT', '/screens/' + encodeURIComponent(id), collect());
      await api('POST', '/screens/' + encodeURIComponent(id) + '/copy', { targets: sameGroup.map((x) => x.id) });
      dlg.close(); await refresh();
    }, 'คัดลอกแล้ว');
  };
  dlg.showModal();
}

$('#reload-all').onclick = () => run(() => api('POST', '/screens/all/reload'), 'ส่งคำสั่งรีโหลดทุกจอแล้ว');

// ------------------------------------------------------------ playlists
function renderPlaylistList() {
  $('#pl-list').innerHTML = state.playlists.map((p) => {
    const used = state.screens.filter((s) => s.defaultPlaylist === p.id || s.schedules.some((x) => x.playlistId === p.id)).length;
    return `<li data-id="${esc(p.id)}" class="${currentPl && currentPl.id === p.id ? 'active' : ''}">${esc(p.name)}
      <small>${p.items.length} รายการ · ใช้กับ ${used} จอ</small></li>`;
  }).join('') || '<li class="muted">ยังไม่มี playlist</li>';
  $$('#pl-list li[data-id]').forEach((li) => li.addEventListener('click', () => {
    if (plDirty && !confirm('playlist ยังไม่ได้บันทึก ทิ้งการแก้ไข?')) return;
    editPlaylist(li.dataset.id);
  }));
  if (currentPl && !plDirty) {
    const fresh = state.playlists.find((p) => p.id === currentPl.id);
    if (fresh) editPlaylist(fresh.id); else { currentPl = null; $('#pl-editor').innerHTML = '<p class="muted">เลือกหรือสร้าง playlist</p>'; }
  }
}

function editPlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  currentPl = JSON.parse(JSON.stringify(p));
  plDirty = false;
  $$('#pl-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  drawPlaylistEditor();
}

function drawPlaylistEditor() {
  const p = currentPl;
  const total = p.items.reduce((a, it) => a + (it.duration || 0), 0);
  $('#pl-editor').innerHTML = `
    <div class="bar">
      <input id="pl-name" value="${esc(p.name)}" style="max-width:340px">
      <div style="display:flex;gap:8px">
        <button class="danger" id="pl-del">ลบ</button>
        <button id="pl-save">บันทึก${plDirty ? ' *' : ''}</button>
      </div>
    </div>
    <p class="hint">${p.items.length} รายการ · ประมาณ ${total} วินาที (ไม่รวมวิดีโอที่เล่นจนจบ) — ระยะเวลา 0 กับวิดีโอ = เล่นจนจบ</p>
    <div class="items">${p.items.map((it, i) => {
      const m = mediaById(it.mediaId);
      return `<div class="item" data-i="${i}">
        <span class="num">${i + 1}</span>${thumb(m)}
        <span>${esc(m ? m.name : '(ไฟล์ถูกลบ)')}</span>
        <span class="opts">
          <input type="number" min="0" max="3600" value="${it.duration}" title="วินาที" data-k="duration">วิ
          <select data-k="fit" title="การจัดภาพ">
            <option value="contain" ${it.fit !== 'cover' ? 'selected' : ''}>พอดีจอ</option>
            <option value="cover" ${it.fit === 'cover' ? 'selected' : ''}>เต็มจอ (ตัดขอบ)</option>
          </select>
          ${m && m.type === 'video' ? `<label class="check" title="ปิดเสียง"><input type="checkbox" data-k="muted" ${it.muted ? 'checked' : ''}>ปิดเสียง</label>` : ''}
          <button class="ghost small" data-mv="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="ghost small" data-mv="1" ${i === p.items.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="danger small" data-rm>✕</button>
        </span></div>`;
    }).join('') || '<p class="muted">ยังไม่มีรายการ — กดสื่อด้านล่างเพื่อเพิ่ม</p>'}</div>
    <strong>เพิ่มสื่อ (กดเพื่อเพิ่มท้าย playlist)</strong>
    <div class="grid picker">${state.media.map((m) => `
      <div class="tile" data-mid="${esc(m.id)}"><div class="pic">${thumb(m, '')}</div>
      <div class="body"><div class="name">${esc(m.name)}</div></div></div>`).join('') || '<p class="muted">ยังไม่มีสื่อ ไปที่แท็บ "สื่อ" เพื่ออัปโหลด</p>'}</div>`;

  const dirty = () => { plDirty = true; $('#pl-save').textContent = 'บันทึก *'; };
  $('#pl-name').oninput = (e) => { p.name = e.target.value; dirty(); };
  $$('#pl-editor .item').forEach((row) => {
    const i = Number(row.dataset.i);
    $$('[data-k]', row).forEach((inp) => (inp.onchange = () => {
      const k = inp.dataset.k;
      p.items[i][k] = k === 'duration' ? Number(inp.value) : k === 'muted' ? inp.checked : inp.value;
      dirty();
    }));
    $$('[data-mv]', row).forEach((b) => (b.onclick = () => {
      const j = i + Number(b.dataset.mv);
      [p.items[i], p.items[j]] = [p.items[j], p.items[i]];
      plDirty = true; drawPlaylistEditor();
    }));
    $('[data-rm]', row).onclick = () => { p.items.splice(i, 1); plDirty = true; drawPlaylistEditor(); };
  });
  $$('#pl-editor .picker .tile').forEach((t) => (t.onclick = () => {
    const m = mediaById(t.dataset.mid);
    p.items.push({ mediaId: m.id, duration: m.type === 'video' ? 0 : m.type === 'web' ? 30 : 10, fit: 'contain', muted: false });
    plDirty = true; drawPlaylistEditor();
  }));
  $('#pl-save').onclick = () => run(async () => {
    await api('PUT', '/playlists/' + p.id, { name: p.name, items: p.items });
    plDirty = false; await refresh();
  }, 'บันทึก playlist แล้ว');
  $('#pl-del').onclick = () => {
    if (!confirm(`ลบ playlist "${p.name}"? จอที่ใช้อยู่จะไม่มีอะไรเล่น`)) return;
    run(async () => { await api('DELETE', '/playlists/' + p.id); currentPl = null; plDirty = false; await refresh(); }, 'ลบแล้ว');
  };
}

$('#pl-new').onclick = () => {
  if (plDirty && !confirm('playlist ยังไม่ได้บันทึก ทิ้งการแก้ไข?')) return;
  const name = prompt('ชื่อ playlist', 'ประชาสัมพันธ์ทั่วไป');
  if (!name) return;
  run(async () => { const p = await api('POST', '/playlists', { name }); plDirty = false; await refresh(); editPlaylist(p.id); }, 'สร้างแล้ว');
};

// ------------------------------------------------------------ media
function renderMedia() {
  $('#media-grid').innerHTML = [...state.media].reverse().map((m) => `
    <div class="tile" data-id="${esc(m.id)}">
      <div class="pic">${m.type === 'video' ? `<video src="/media/${esc(m.file)}#t=1" preload="metadata" muted controls></video>` : thumb(m, '')}</div>
      <div class="body">
        <div class="name">${esc(m.name)}</div>
        <div class="muted">${m.type === 'web' ? esc(m.url) : (m.type === 'video' ? 'วิดีโอ' : 'รูป') + ' · ' + fmtSize(m.size || 0)}</div>
        <div class="actions"><button class="ghost small" data-ren>เปลี่ยนชื่อ</button><button class="danger small" data-del>ลบ</button></div>
      </div>
    </div>`).join('') || '<p class="muted">ยังไม่มีสื่อ</p>';
  $$('#media-grid .tile').forEach((t) => {
    const m = mediaById(t.dataset.id);
    $('[data-ren]', t).onclick = () => {
      const name = prompt('ชื่อใหม่', m.name);
      if (name) run(async () => { await api('PATCH', '/media/' + m.id, { name }); await refresh(); });
    };
    $('[data-del]', t).onclick = () => {
      const n = state.playlists.filter((p) => p.items.some((it) => it.mediaId === m.id)).length;
      if (!confirm(`ลบ "${m.name}"?${n ? `\nจะถูกเอาออกจาก ${n} playlist ด้วย` : ''}`)) return;
      run(async () => { await api('DELETE', '/media/' + m.id); await refresh(); }, 'ลบแล้ว');
    };
  });
}

function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append('files', f));
  const bar = $('#upload-progress');
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/media');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = (e.loaded / e.total * 100) + '%'; };
  xhr.onload = async () => {
    bar.hidden = true; bar.firstElementChild.style.width = '0';
    let res = {}; try { res = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status >= 400) return toast('อัปโหลดไม่สำเร็จ: ' + (res.error || xhr.status));
    toast(`อัปโหลดแล้ว ${res.length} ไฟล์`);
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
  run(async () => { await api('POST', '/media/web', { name: f.name.value, url: f.url.value }); f.reset(); await refresh(); }, 'เพิ่มแล้ว');
};

// ------------------------------------------------------------ settings
function renderSettings() {
  const f = $('#settings-form');
  if (document.activeElement && f.contains(document.activeElement)) return;
  f.tickerText.value = state.settings.tickerText || '';
  f.tickerEnabled.checked = !!state.settings.tickerEnabled;
  f.tickerSpeed.value = state.settings.tickerSpeed || 80;
  $('#server-url').textContent = location.origin;
  $('#browser-url').textContent = location.origin + '/player/?id=ชื่อจอ';
}

$('#settings-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  run(async () => {
    await api('PUT', '/settings', { tickerText: f.tickerText.value, tickerEnabled: f.tickerEnabled.checked, tickerSpeed: Number(f.tickerSpeed.value) });
    await refresh();
  }, 'บันทึกแล้ว');
};

// ------------------------------------------------------------ boot
refresh().catch((e) => toast('โหลดข้อมูลไม่ได้: ' + e.message));
// keep screen status fresh (skip while a dialog is open or a playlist is being edited)
setInterval(() => {
  if ($('#screen-dialog').open || plDirty || document.hidden) return;
  api('GET', '/state').then((s) => { state = s; renderScreens(); }).catch(() => {});
}, 15000);
