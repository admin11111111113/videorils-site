/* Своя статистика сайта videorils.com: анонимные счётчики (просмотр, визит, источник, страница, время на странице). Без cookies и без личных данных. */
(function () {
  try {
    if (!/(^|\.)videorils\.com$/.test(location.hostname)) return;
    var url = 'https://videorils-tts.videorils.workers.dev/site/ev';
    var send = function (o) {
      var body = JSON.stringify(o);
      try { if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return; } catch (e) { }
      try { fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: body }); } catch (e) { }
    };
    var bot = !!navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|bingpreview/i.test(navigator.userAgent || '');
    // источник визита: рекламные метки -> utm_source -> сайт, с которого пришли -> прямой заход
    var srcOf = function () {
      var q = new URLSearchParams(location.search), r = document.referrer || '', h = '';
      if (q.get('yclid')) return 'yandex_ads';
      if (q.get('rb_clickid') || /^(vk_ads|vkads|vk_reklama|mytarget)$/i.test(q.get('utm_source') || '')) return 'vk_ads';
      if (q.get('gclid') || q.get('gbraid') || q.get('wbraid')) return 'google_ads';
      if (q.get('ttclid')) return 'tiktok_ads';
      var u = (q.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
      if (u) return u;
      try { h = new URL(r).hostname.toLowerCase(); } catch (e) { }
      if (!h) return 'direct';
      var R = [[/google\./, 'google'], [/yandex\.|(^|\.)ya\.ru$/, 'yandex'], [/bing\.com$/, 'bing'], [/duckduckgo\./, 'duckduckgo'], [/yahoo\./, 'yahoo'],
        [/tiktok\.com$/, 'tiktok'], [/instagram\.com$/, 'instagram'], [/facebook\.com$|fb\.com$/, 'facebook'], [/youtube\.com$|youtu\.be$/, 'youtube'],
        [/(^|\.)t\.me$|telegram\./, 'telegram'], [/(^|\.)ads\.vk\.com$|mytarget/, 'vk_ads'], [/(^|\.)vk\.(com|ru)$|vkontakte/, 'vk'], [/(^|\.)videorils\.com$/, 'internal']];
      for (var i = 0; i < R.length; i++) if (R[i][0].test(h)) return R[i][1];
      return 'other';
    };
    var d = new Date().toISOString().slice(0, 10), b = { u: location.pathname }, src = 'direct', entry = false;
    if (bot) b.b = 1;
    try {
      if (!sessionStorage.getItem('vr_sv_s')) { src = srcOf(); sessionStorage.setItem('vr_sv_s', src); b.s = 1; entry = true; }
      else src = sessionStorage.getItem('vr_sv_s') || 'direct';
    } catch (e) { src = srcOf(); b.s = 1; entry = true; }
    b.src = src;
    var sid = ''; try { sid = sessionStorage.getItem('vr_sv_sid') || ''; if (!sid) { sid = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('vr_sv_sid', sid); } } catch (e) { }
    b.sid = sid; b.dev = (matchMedia('(pointer:coarse)').matches || Math.min(screen.width, screen.height) < 700) ? 'm' : 'd';
    try { if (localStorage.getItem('vr_sv_d') !== d) { localStorage.setItem('vr_sv_d', d); b.v = 1; } if (!localStorage.getItem('vr_sv_f')) { localStorage.setItem('vr_sv_f', d); b.n = 1; } } catch (e) { }
    send(b);
    if (bot) return;
    // время на странице: считаем только пока вкладка видна; отправляем один раз при уходе
    var shown = document.visibilityState === 'visible' ? Date.now() : 0, total = 0, sent = false;
    var flush = function () {
      if (shown) { total += Date.now() - shown; shown = 0; }
      if (sent) return; var t = Math.round(total / 1000); if (t < 1) t = 1;
      sent = true; send({ u: location.pathname, t: Math.min(t, 1800), src: src, e: entry ? 1 : 0, sid: sid });
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(); else if (!sent) shown = Date.now();
    });
    window.addEventListener('pagehide', flush);
  } catch (e) { }
})();
