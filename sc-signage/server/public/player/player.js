/*
 * SC Signage player. ES5 on purpose: cheap Android boxes often ship an old WebView.
 *
 * Plays the content deployed to this player's group: zone layouts (main / side / bottom,
 * same zones as piSignage), schedules, TV on/off times, ticker and emergency messages.
 * Keeps working offline from the last config (localStorage); the Android app also caches media.
 */
(function () {
  'use strict';

  var POLL_MS = 20000;
  var STALL_MS = 20000;
  var ANDROID = window.ScAndroid || null;

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  var preview = qs('preview') === '1';
  var playerId = (qs('id') || store('sc_screen_id') || ('web-' + Math.random().toString(36).slice(2, 8))).replace(/[^\w.-]/g, '').slice(0, 64);
  if (!preview) store('sc_screen_id', playerId);
  var appVersion = '';
  try { appVersion = ANDROID && ANDROID.version ? ANDROID.version() : ''; } catch (e) {}

  var cfg = null;
  var online = false;
  var clockOffset = Number(store('sc_clock_offset') || 0);
  var reloadBase = null, snapBase = null;
  var status = { pl: '', asset: '', tv: 1 };

  function now() { return new Date(Date.now() + clockOffset); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toMin(t) { var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }

  // ---------------------------------------------------------------- config
  function fetchConfig() {
    var xhr = new XMLHttpRequest();
    var q = preview ? '?preview=1' : '?app=' + (ANDROID ? 'android' : 'browser') + '&v=' + encodeURIComponent(appVersion) +
      '&pl=' + encodeURIComponent(status.pl) + '&asset=' + encodeURIComponent(status.asset) + '&tv=' + status.tv;
    xhr.open('GET', '/api/player/' + encodeURIComponent(playerId) + q, true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      if (xhr.status !== 200) return setOnline(false);
      var c;
      try { c = JSON.parse(xhr.responseText); } catch (e) { return setOnline(false); }
      setOnline(true);
      applyConfig(c, true);
      renderInfo();
    };
    xhr.onerror = xhr.ontimeout = function () { setOnline(false); };
    xhr.send();
  }

  function applyConfig(c, fromNetwork) {
    var oldKey = cfg ? JSON.stringify([cfg.content, cfg.emergency]) : '';
    cfg = c;
    if (fromNetwork) {
      clockOffset = c.serverTime - Date.now();
      store('sc_clock_offset', String(clockOffset));
      if (!preview) store('sc_cfg_' + playerId, JSON.stringify(c));
      // remote commands: first answer sets the baseline, a newer timestamp triggers
      var r = c.player.reloadAt || 0, s = c.player.snapshotReq || 0;
      if (reloadBase === null) reloadBase = r; else if (r > reloadBase && !preview) { location.reload(); return; }
      if (snapBase === null) snapBase = s; else if (s > snapBase) { snapBase = s; takeSnapshot(); }
    }
    $('idle-name').textContent = c.player.name;
    applyRotation();
    if (JSON.stringify([c.content, c.emergency]) !== oldKey) {
      prefetch();
      evaluate(true);
    }
  }

  function setOnline(v) {
    online = v;
    $('net').style.display = v || preview ? 'none' : 'block';
    renderInfo();
  }

  function eachAsset(fn) {
    var lists = [];
    if (cfg && cfg.content) for (var id in cfg.content.playlists) lists.push(cfg.content.playlists[id]);
    if (cfg && cfg.emergency && cfg.emergency.playlist) lists.push(cfg.emergency.playlist);
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].items.length; j++) {
        var it = lists[i].items[j];
        fn(it.main); if (it.side) fn(it.side); if (it.bottom) fn(it.bottom);
      }
    }
  }

  function prefetch() {
    if (!ANDROID || !ANDROID.prefetch) return;
    var urls = [], seen = {};
    eachAsset(function (a) {
      var list = [a.src];
      if (a.notice && a.notice.image) list.push(a.notice.image);
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (u && u.charAt(0) === '/' && !seen[u]) { seen[u] = 1; urls.push(location.origin + u); }
      }
    });
    try { ANDROID.prefetch(JSON.stringify(urls)); } catch (e) {}
  }

  function takeSnapshot() {
    if (ANDROID && ANDROID.snapshot) { try { ANDROID.snapshot(); } catch (e) {} }
  }

  // ---------------------------------------------------------------- schedule / validity / tv
  function dayWindow(row, d, startKey, endKey) {
    var today = ymd(d);
    if (row.dateFrom && today < row.dateFrom) return false;
    if (row.dateTo && today > row.dateTo) return false;
    var m = d.getHours() * 60 + d.getMinutes();
    var a = toMin(row[startKey]), b = toMin(row[endKey]);
    var day = d.getDay();
    if (a <= b) return row.days.indexOf(day) >= 0 && m >= a && m < b;
    if (m >= a) return row.days.indexOf(day) >= 0;           // overnight: evening part
    if (m < b) return row.days.indexOf((day + 6) % 7) >= 0; // overnight: early-morning part
    return false;
  }

  function activePlaylist() {
    var c = cfg && cfg.content;
    if (!c) return null;
    var d = now();
    for (var i = 0; i < c.schedules.length; i++) {
      if (dayWindow(c.schedules[i], d, 'start', 'end')) return c.playlists[c.schedules[i].playlistId] || null;
    }
    return c.playlists[c.defaultPlaylist] || null;
  }

  // TV on/off like piSignage: dated rows replace the weekly rows on their days
  function tvShouldBeOn() {
    var tv = cfg && cfg.content && cfg.content.tv;
    if (!tv || !tv.enabled || !tv.rows.length) return true;
    var d = now(), today = ymd(d), dated = [], weekly = [];
    for (var i = 0; i < tv.rows.length; i++) {
      var r = tv.rows[i];
      if (r.dateFrom || r.dateTo) {
        if ((!r.dateFrom || today >= r.dateFrom) && (!r.dateTo || today <= r.dateTo)) dated.push(r);
      } else weekly.push(r);
    }
    var rows = dated.length ? dated : weekly;
    for (var j = 0; j < rows.length; j++) if (dayWindow(rows[j], d, 'on', 'off')) return true;
    return false;
  }

  function valid(a) {
    if (!a) return false;
    var t = ymd(now());
    return (!a.validFrom || t >= a.validFrom) && (!a.validTo || t <= a.validTo);
  }

  // ---------------------------------------------------------------- zones
  function Zone(name) {
    this.name = name;
    this.box = el('div', 'zone');
    this.layers = [el('div', 'layer'), el('div', 'layer')];
    this.box.appendChild(this.layers[0]);
    this.box.appendChild(this.layers[1]);
    this.front = 0;
    this.key = '';
    this.gen = 0;
  }

  Zone.prototype.place = function (r) {
    var s = this.box.style;
    s.left = r[0] + '%'; s.top = r[1] + '%'; s.width = r[2] + '%'; s.height = r[3] + '%';
  };

  Zone.prototype.clear = function () {
    this.gen++;
    this.key = '';
    for (var i = 0; i < 2; i++) { clearLayer(this.layers[i]); this.layers[i].className = 'layer'; }
  };

  // show(asset, opts) — opts: fit, muted, loop, onShown(videoEl|null), onEnded, onError
  Zone.prototype.show = function (a, opts) {
    var self = this;
    var key = a ? a.id + '|' + (opts.fit || '') : '';
    if (!a) { this.clear(); return; }
    if (key === this.key && a.type !== 'video' && !opts.force) { if (opts.onShown) opts.onShown(null); return; }
    this.key = key;
    var my = ++this.gen;
    var back = this.layers[1 - this.front], cur = this.layers[this.front];
    clearLayer(back);
    var done = false;
    function live() { return my === self.gen; }
    function reveal(v) {
      if (done || !live()) return;
      done = true;
      back.className = 'layer show';
      cur.className = 'layer';
      self.front = 1 - self.front;
      setTimeout(function () { if (self.layers[1 - self.front] === cur) clearLayer(cur); }, 800);
      if (opts.onShown) opts.onShown(v || null);
    }
    function fail() { if (live() && opts.onError) opts.onError(); }
    var cls = opts.fit === 'cover' ? 'cover' : '';

    if (a.type === 'image') {
      var img = new Image();
      img.className = cls;
      img.onload = function () { reveal(); };
      img.onerror = fail;
      img.src = a.src;
      back.appendChild(img);
    } else if (a.type === 'video') {
      var v = el('video', cls);
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'auto';
      v.muted = !!opts.muted;
      v.loop = !!opts.loop;
      v.src = a.src;
      v.onerror = fail;
      v.onended = function () { if (live() && opts.onEnded) opts.onEnded(); };
      v.onplaying = function () { reveal(v); };
      back.appendChild(v);
      var p = v.play();
      if (p && p['catch']) p['catch'](function () {
        v.muted = true; // autoplay with sound blocked (plain browsers): retry muted
        var p2 = v.play();
        if (p2 && p2['catch']) p2['catch'](fail);
      });
    } else if (a.type === 'notice') {
      back.appendChild(renderNotice(a.notice, this.box));
      setTimeout(function () { reveal(); }, 30);
    } else { // web, html
      var f = el('iframe');
      f.setAttribute('allow', 'autoplay; fullscreen');
      f.setAttribute('scrolling', 'no');
      f.onload = function () { reveal(); };
      f.src = a.src;
      back.appendChild(f);
      setTimeout(function () { reveal(); }, 4000); // some sites never fire load
    }
  };

  function clearLayer(layer) {
    var v = layer.getElementsByTagName('video');
    for (var i = 0; i < v.length; i++) { try { v[i].pause(); v[i].removeAttribute('src'); v[i].load(); } catch (e) {} }
    layer.innerHTML = '';
  }

  function renderNotice(n, box) {
    var d = el('div', 'notice' + (n.image ? ' has-img' : ''));
    d.style.background = n.bg;
    d.style.color = n.color;
    if (n.image) { d.style.backgroundImage = 'url("' + n.image + '")'; d.style.backgroundSize = 'cover'; d.style.backgroundPosition = 'center'; }
    // scale text to the zone, not the whole screen
    d.style.fontSize = Math.max(12, Math.min(box.offsetHeight / 14, box.offsetWidth / 22)) + 'px';
    var parts = [['n-title', n.title], ['n-body', n.body], ['n-footer', n.footer]];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i][1]) continue;
      var p = el('div', parts[i][0]);
      p.textContent = parts[i][1];
      d.appendChild(p);
    }
    return d;
  }

  var zones = { main: new Zone('main'), side: new Zone('side'), bottom: new Zone('bottom') };
  var currentLayout = '';

  // คืนพิกัดโซนของ playlist: ใช้ค่าที่ปรับขนาดแล้ว (pl.zones) ถ้ามี ไม่งั้นใช้ตาม layout
  function zonesOf(pl) {
    if (pl && pl.zones) return pl.zones;
    var layouts = (cfg && cfg.content && cfg.content.layouts) || { '1': { main: [0, 0, 100, 100] } };
    return layouts[pl && pl.layout] || layouts['1'];
  }

  function setLayout(pl) {
    var L = zonesOf(pl);
    var key = (pl ? pl.layout : '1') + '|' + JSON.stringify(L);
    if (key === currentLayout) return;
    currentLayout = key;
    var holder = $('zones');
    for (var z in zones) {
      if (L[z]) {
        zones[z].place(L[z]);
        if (zones[z].box.parentNode !== holder) holder.appendChild(zones[z].box);
      } else {
        zones[z].clear();
        if (zones[z].box.parentNode) holder.removeChild(zones[z].box);
      }
    }
  }

  // ---------------------------------------------------------------- playback (main zone drives timing)
  var playlist = null, plKey = '', idx = -1, timer = null, stallTimer = null, lastProgress = 0, step = 0;

  function stopTimers() { clearTimeout(timer); clearInterval(stallTimer); timer = stallTimer = null; }

  function stopAll() {
    stopTimers();
    step++;
    for (var z in zones) zones[z].clear();
    playlist = null; plKey = ''; currentLayout = '';
    status.pl = ''; status.asset = '';
  }

  // decide what should be on screen right now
  function evaluate(force) {
    tickClock();
    var em = cfg && cfg.emergency;
    var tvOn = em ? true : tvShouldBeOn();
    setTv(tvOn);
    $('emergency').style.display = em && !em.playlist && em.message ? 'block' : 'none';
    if (em && !em.playlist) $('emergency-msg').textContent = em.message;

    var pl = !tvOn ? null : em && em.playlist ? em.playlist : em && em.message ? null : activePlaylist();
    var key = pl ? pl.id + JSON.stringify(pl) : '';
    if (key === plKey && !force) { checkValidityChange(); return; }
    var sameList = pl && playlist && pl.id === playlist.id;
    if (!pl) { stopAll(); showIdle(tvOn && !(em && em.message)); renderTicker(null); return; }
    showIdle(false);
    playlist = pl; plKey = key;
    status.pl = pl.name;
    renderTicker(pl.ticker);
    setLayout(pl);
    if (!sameList) { idx = -1; next(); return; }
    // same playlist edited: let the current item finish, then continue with the new list
    if (idx >= pl.items.length) idx = -1;
    if (!timer && !stallTimer) next();
  }

  function playableItems() {
    var out = [];
    if (!playlist) return out;
    for (var i = 0; i < playlist.items.length; i++) if (valid(playlist.items[i].main)) out.push(i);
    return out;
  }

  var lastValidCount = -1;
  function checkValidityChange() {
    var n = playableItems().length;
    if (n !== lastValidCount && lastValidCount === 0 && n > 0) { showIdle(false); next(); }
    lastValidCount = n;
  }

  function next() {
    stopTimers();
    if (!playlist) return;
    var ok = playableItems();
    lastValidCount = ok.length;
    if (!ok.length) { for (var z in zones) zones[z].clear(); showIdle(true); status.asset = ''; return; }
    showIdle(false);
    // advance to the next playable item after idx
    var nxt = ok[0];
    for (var k = 0; k < ok.length; k++) if (ok[k] > idx) { nxt = ok[k]; break; }
    idx = nxt;
    var it = playlist.items[idx];
    var my = ++step;
    function live() { return my === step; }
    function skip() { if (!live()) return; stopTimers(); timer = setTimeout(next, 1000); }
    status.asset = it.main.name;
    renderInfo();

    var single = ok.length === 1 && it.main.type !== 'video';
    // load timeout; replaced once the main asset reports it is shown (possibly synchronously)
    timer = setTimeout(function () { if (live()) next(); }, 20000);
    zones.main.show(it.main, {
      fit: it.fit, muted: it.muted, loop: false, force: !single,
      onShown: function (video) {
        if (!live()) return;
        stopTimers();
        if (video) {
          lastProgress = Date.now();
          video.ontimeupdate = function () { lastProgress = Date.now(); };
          stallTimer = setInterval(function () { if (Date.now() - lastProgress > STALL_MS) next(); }, 5000);
        }
        if (it.duration) timer = setTimeout(next, Math.max(3, it.duration) * 1000);
      },
      onEnded: function () { if (live() && !it.duration) next(); },
      onError: skip
    });

    var L = zonesOf(playlist);
    var extra = ['side', 'bottom'];
    for (var e = 0; e < extra.length; e++) {
      var zn = extra[e];
      if (!L[zn]) continue;
      var a = it[zn] && valid(it[zn]) ? it[zn] : null;
      // โซนข้าง/ล่างใช้ "contain" (พอดีโซน) กันภาพล้นขอบ/ถูกตัด — เหมาะกับโลโก้
      if (a) zones[zn].show(a, { fit: 'contain', muted: true, loop: true, onError: function () {} });
      else zones[zn].clear();
    }
  }

  function setTv(on) {
    var v = on ? 1 : 0;
    $('tvoff').style.display = on ? 'none' : 'block';
    if (v === status.tv) return;
    status.tv = v;
    if (ANDROID && ANDROID.setScreenOn) { try { ANDROID.setScreenOn(on); } catch (e) {} }
  }

  // ---------------------------------------------------------------- idle / ticker / rotation
  var TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  var TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  function showIdle(v) { $('idle').style.display = v ? 'block' : 'none'; }
  function tickClock() {
    var d = now();
    $('idle-clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    $('idle-date').textContent = 'วัน' + TH_DAYS[d.getDay()] + 'ที่ ' + d.getDate() + ' ' + TH_MONTHS[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  }

  var ticker = null, tickerX = 0, tickerW = 0, tickerLast = 0;
  function renderTicker(t) {
    ticker = t && t.enabled && t.text ? t : null;
    $('ticker').style.display = ticker ? 'block' : 'none';
    if (!ticker) return;
    var span = $('ticker-text');
    var text = ticker.text.replace(/\s*\n\s*/g, '     •     ');
    if (span.textContent !== text) { span.textContent = text; tickerX = $('stage').offsetWidth; }
    tickerW = span.offsetWidth;
  }
  function tickerFrame(ts) {
    if (ticker) {
      var dt = tickerLast ? Math.min(100, ts - tickerLast) : 0;
      tickerX -= (ticker.speed || 80) * dt / 1000;
      if (tickerX < -tickerW) tickerX = $('stage').offsetWidth;
      var s = $('ticker-text').style;
      s.webkitTransform = s.transform = 'translateX(' + tickerX.toFixed(1) + 'px)';
    }
    tickerLast = ts;
    requestAnimationFrame(tickerFrame);
  }

  function applyRotation() {
    var r = (cfg && cfg.content && cfg.content.orientation) || 0;
    var s = $('stage').style, W = window.innerWidth, H = window.innerHeight;
    var tf = 'none', w = W, h = H, origin = '0 0';
    if (r === 90) { w = H; h = W; tf = 'translate(' + W + 'px,0) rotate(90deg)'; }
    else if (r === 270) { w = H; h = W; tf = 'translate(0,' + H + 'px) rotate(270deg)'; }
    else if (r === 180) { tf = 'rotate(180deg)'; origin = '50% 50%'; }
    s.width = w + 'px'; s.height = h + 'px';
    s.webkitTransformOrigin = s.transformOrigin = origin;
    s.webkitTransform = s.transform = tf;
  }

  // ---------------------------------------------------------------- info overlay
  var infoVisible = false;
  function renderInfo() {
    if (!infoVisible) return;
    var box = $('info');
    box.innerHTML = '';
    var lines = [
      'จอ: ' + (cfg ? cfg.player.name : '-') + (cfg && cfg.player.group ? '  (กลุ่ม ' + cfg.player.group + ')' : ''),
      'ID: ' + playerId,
      'เซิร์ฟเวอร์: ' + location.host,
      'สถานะ: ' + (online ? 'ออนไลน์' : 'ออฟไลน์ (เล่นจากข้อมูลล่าสุด)'),
      'กำลังเล่น: ' + (status.pl || '-') + (status.asset ? ' / ' + status.asset : ''),
      'Deploy ล่าสุด: ' + (cfg && cfg.deployedAt ? new Date(cfg.deployedAt).toLocaleString('th-TH') : 'ยังไม่มี')
    ];
    for (var i = 0; i < lines.length; i++) { var d = el('div'); d.textContent = lines[i]; box.appendChild(d); }
  }
  function showInfo(ms) {
    infoVisible = true;
    renderInfo();
    $('info').style.display = 'block';
    clearTimeout(showInfo._h);
    showInfo._h = setTimeout(function () { infoVisible = false; $('info').style.display = 'none'; }, ms || 10000);
  }
  document.addEventListener('keydown', function (e) { if (e.keyCode === 73 || e.keyCode === 13) showInfo(); });
  window.scShowInfo = showInfo;

  // ---------------------------------------------------------------- boot
  window.addEventListener('resize', function () {
    applyRotation();
    if (ticker) renderTicker(ticker);
  });
  var cached = preview ? null : store('sc_cfg_' + playerId);
  if (cached) {
    try {
      var cc = JSON.parse(cached);
      if (cc && cc.player && 'content' in cc) applyConfig(cc, false); // ignore configs saved by older versions
    } catch (e) { cfg = null; }
  }
  if (!cfg) { tickClock(); showIdle(true); }
  fetchConfig();
  setInterval(fetchConfig, POLL_MS);
  setInterval(function () { evaluate(false); }, 15000);
  setInterval(function () { if (ANDROID && ANDROID.heartbeat) { try { ANDROID.heartbeat(); } catch (e) {} } }, 10000);
  requestAnimationFrame(tickerFrame);
  showInfo(8000);
})();
