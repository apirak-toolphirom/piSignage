/*
 * UBU Signage player. Written in ES5 on purpose: cheap Android boxes often ship
 * an old WebView. Keeps working offline from the last config (localStorage);
 * the Android app additionally caches media files on the device.
 */
(function () {
  'use strict';

  var POLL_MS = 20000;
  var STALL_MS = 20000;          // video with no progress for this long -> skip
  var ANDROID = window.UbuAndroid || null;

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var preview = qs('preview') === '1';
  var screenId = qs('id') || store('ubu_screen_id');
  if (!screenId) {
    screenId = 'web-' + Math.random().toString(36).slice(2, 8);
  }
  screenId = screenId.replace(/[^\w.-]/g, '').slice(0, 64);
  if (!preview) store('ubu_screen_id', screenId);

  var cfg = null;
  var clockOffset = Number(store('ubu_clock_offset') || 0);
  var online = false;
  var reloadBaseline = null;

  function now() { return new Date(Date.now() + clockOffset); }

  // ---------------------------------------------------------------- config
  function applyConfig(c, fromNetwork) {
    var first = !cfg;
    var oldRev = cfg ? cfg.rev : -1;
    cfg = c;
    if (fromNetwork) {
      clockOffset = c.serverTime - Date.now();
      store('ubu_clock_offset', String(clockOffset));
      if (!preview) store('ubu_cfg_' + screenId, JSON.stringify(c));
      // remote reload command
      // remote reload: first answer after page load sets the baseline, a newer value reloads
      var r = c.screen.reloadAt || 0;
      if (reloadBaseline === null) reloadBaseline = r;
      else if (r > reloadBaseline && !preview) { location.reload(); return; }
    }
    applyRotation();
    if (first || oldRev !== c.rev) {
      prefetch();
      renderTicker();
      $('idle-name').textContent = c.screen.name;
      reschedule(true);
    }
  }

  function fetchConfig() {
    var xhr = new XMLHttpRequest();
    var url = '/api/player/' + encodeURIComponent(screenId) + (preview ? '?preview=1' : '?app=' + encodeURIComponent(ANDROID ? 'android' : 'browser'));
    xhr.open('GET', url, true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      if (xhr.status !== 200) return setOnline(false);
      try { setOnline(true); applyConfig(JSON.parse(xhr.responseText), true); renderInfo(); }
      catch (e) { setOnline(false); }
    };
    xhr.onerror = xhr.ontimeout = function () { setOnline(false); };
    xhr.send();
  }

  function setOnline(v) {
    online = v;
    $('net').style.display = v || preview ? 'none' : 'block';
    renderInfo();
  }

  function prefetch() {
    if (!ANDROID || !ANDROID.prefetch || !cfg) return;
    var urls = [], seen = {};
    for (var id in cfg.playlists) {
      var items = cfg.playlists[id];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.type !== 'web' && !seen[it.src]) { seen[it.src] = 1; urls.push(location.origin + it.src); }
      }
    }
    try { ANDROID.prefetch(JSON.stringify(urls)); } catch (e) {}
  }

  // ---------------------------------------------------------------- schedule
  function toMin(t) { var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function scheduleMatches(s, d) {
    var today = ymd(d);
    if (s.dateFrom && today < s.dateFrom) return false;
    if (s.dateTo && today > s.dateTo) return false;
    var m = d.getHours() * 60 + d.getMinutes();
    var a = toMin(s.start), b = toMin(s.end);
    var day = d.getDay();
    if (a <= b) return s.days.indexOf(day) >= 0 && m >= a && m < b;
    // overnight window (e.g. 22:00-06:00): evening part belongs to the start day
    if (m >= a) return s.days.indexOf(day) >= 0;
    if (m < b) return s.days.indexOf((day + 6) % 7) >= 0;
    return false;
  }

  function activePlaylistId() {
    if (!cfg) return '';
    var d = now();
    for (var i = 0; i < cfg.schedules.length; i++) {
      if (scheduleMatches(cfg.schedules[i], d)) return cfg.schedules[i].playlistId;
    }
    return cfg.defaultPlaylist;
  }

  // ---------------------------------------------------------------- playback
  var layers = [$('layerA'), $('layerB')];
  var front = 0;
  var plId = null, items = [], idx = -1;
  var timer = null, stallTimer = null, lastProgress = 0, lastKey = '', playGen = 0;

  function reschedule(configChanged) {
    var id = activePlaylistId();
    var list = (cfg && cfg.playlists[id]) || [];
    var key = id + '|' + JSON.stringify(list);
    if (id === plId && key === lastKey) return;
    var restart = id !== plId;
    plId = id; items = list; lastKey = key;
    if (!items.length) { stop(); showIdle(true); return; }
    showIdle(false);
    if (restart) { idx = -1; next(); return; }
    // same playlist, edited: let the current item finish, continue with the new list
    if (idx >= items.length) idx = -1;
    if (!timer && !stallTimer) next();
  }

  function stop() {
    clearTimeout(timer); clearInterval(stallTimer); timer = stallTimer = null;
    for (var i = 0; i < layers.length; i++) { clearLayer(layers[i]); layers[i].className = 'layer'; }
  }

  function clearLayer(el) {
    var v = el.getElementsByTagName('video');
    for (var i = 0; i < v.length; i++) { try { v[i].pause(); v[i].removeAttribute('src'); v[i].load(); } catch (e) {} }
    el.innerHTML = '';
  }

  function next() {
    clearTimeout(timer); clearInterval(stallTimer); timer = stallTimer = null;
    if (!items.length) return;
    idx = (idx + 1) % items.length;
    var it = items[idx];
    var back = layers[1 - front];
    var cur = layers[front];

    // a single still item: nothing to change
    if (items.length === 1 && cur.getAttribute('data-src') === it.src && it.type !== 'video') {
      timer = setTimeout(next, Math.max(5, it.duration) * 1000);
      return;
    }

    clearLayer(back);
    back.setAttribute('data-src', it.src);
    var done = false, my = ++playGen;
    function live() { return my === playGen; }
    function reveal() {
      if (done || !live()) return; done = true;
      back.className = 'layer show';
      cur.className = 'layer';
      front = 1 - front;
      setTimeout(function () { if (layers[1 - front] === cur) clearLayer(cur); }, 800);
    }
    function skip() { if (!live()) return; clearTimeout(timer); timer = setTimeout(next, 1000); }
    var cls = it.fit === 'cover' ? 'cover' : '';

    if (it.type === 'image') {
      var img = new Image();
      img.className = cls;
      timer = setTimeout(next, 20000); // load timeout; replaced once the image is shown
      img.onload = function () { if (!live()) return; clearTimeout(timer); reveal(); timer = setTimeout(next, it.duration * 1000); };
      img.onerror = skip;
      img.src = it.src;
      back.appendChild(img);
    } else if (it.type === 'video') {
      var v = document.createElement('video');
      v.className = cls;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'auto';
      v.muted = !!it.muted;
      v.loop = false;
      v.src = it.src;
      v.onerror = skip;
      v.onended = function () { if (live() && !it.duration) next(); };
      v.ontimeupdate = function () { lastProgress = Date.now(); };
      v.onplaying = reveal;
      back.appendChild(v);
      lastProgress = Date.now();
      var p = v.play();
      if (p && p['catch']) p['catch'](function () {
        // autoplay with sound blocked (plain browsers): retry muted
        v.muted = true;
        var p2 = v.play();
        if (p2 && p2['catch']) p2['catch'](skip);
      });
      if (it.duration) timer = setTimeout(next, it.duration * 1000);
      stallTimer = setInterval(function () { if (Date.now() - lastProgress > STALL_MS) next(); }, 5000);
    } else {
      var f = document.createElement('iframe');
      f.setAttribute('allow', 'autoplay; fullscreen');
      f.onload = reveal;
      f.src = it.src;
      back.appendChild(f);
      setTimeout(reveal, 4000); // some sites never fire load
      timer = setTimeout(next, it.duration * 1000);
    }
  }

  // ---------------------------------------------------------------- idle / ticker / rotation
  var TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  var TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  function showIdle(v) { $('idle').style.display = v ? 'block' : 'none'; tickClock(); }
  function tickClock() {
    var d = now();
    $('idle-clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    $('idle-date').textContent = 'วัน' + TH_DAYS[d.getDay()] + 'ที่ ' + d.getDate() + ' ' + TH_MONTHS[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  }

  var tickerX = 0, tickerW = 0, tickerLast = 0, tickerOn = false;
  function renderTicker() {
    var t = cfg && cfg.ticker;
    tickerOn = !!(t && t.enabled && t.text);
    $('ticker').style.display = tickerOn ? 'block' : 'none';
    if (!tickerOn) return;
    var span = $('ticker-text');
    span.textContent = t.text.replace(/\s*\n\s*/g, '   •   ');
    tickerW = span.offsetWidth;
    tickerX = $('stage').offsetWidth;
  }
  function tickerFrame(ts) {
    if (tickerOn) {
      var dt = tickerLast ? Math.min(100, ts - tickerLast) : 0;
      tickerX -= (cfg.ticker.speed || 80) * dt / 1000;
      if (tickerX < -tickerW) tickerX = $('stage').offsetWidth;
      var s = $('ticker-text').style;
      s.webkitTransform = s.transform = 'translateX(' + tickerX.toFixed(1) + 'px)';
    }
    tickerLast = ts;
    requestAnimationFrame(tickerFrame);
  }

  function applyRotation() {
    var r = (cfg && cfg.screen.rotation) || 0;
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
    var el = $('info');
    el.innerHTML = '';
    var lines = ['จอ: ' + (cfg ? cfg.screen.name : '-'), 'ID: ' + screenId, 'เซิร์ฟเวอร์: ' + location.host,
      'สถานะ: ' + (online ? 'ออนไลน์' : 'ออฟไลน์ (เล่นจากข้อมูลล่าสุด)')];
    for (var i = 0; i < lines.length; i++) { var div = document.createElement('div'); div.textContent = lines[i]; el.appendChild(div); }
  }
  function showInfo(ms) {
    infoVisible = true;
    renderInfo();
    $('info').style.display = 'block';
    clearTimeout(showInfo._h);
    showInfo._h = setTimeout(function () { infoVisible = false; $('info').style.display = 'none'; }, ms || 10000);
  }
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 73 /* i */ || e.keyCode === 13 /* OK */) showInfo();
  });
  window.ubuShowInfo = showInfo; // called from the Android app

  // ---------------------------------------------------------------- boot
  window.addEventListener('resize', function () { applyRotation(); renderTicker(); });
  var cached = preview ? null : store('ubu_cfg_' + screenId);
  if (cached) { try { applyConfig(JSON.parse(cached), false); } catch (e) {} }
  if (!cfg) showIdle(true);
  fetchConfig();
  setInterval(fetchConfig, POLL_MS);
  setInterval(function () { tickClock(); reschedule(false); }, 15000);
  setInterval(function () { if (ANDROID && ANDROID.heartbeat) { try { ANDROID.heartbeat(); } catch (e) {} } }, 10000);
  requestAnimationFrame(tickerFrame);
  showInfo(8000);
})();
