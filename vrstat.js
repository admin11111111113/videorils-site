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
    var d = new Date().toISOString().slice(0, 10), b = { u: location.pathname };
    if (bot) b.b = 1;
    try { if (!sessionStorage.getItem('vr_sv_s')) { sessionStorage.setItem('vr_sv_s', '1'); b.s = 1; b.r = document.referrer || ''; var q = new URLSearchParams(location.search); b.utm = q.get('utm_source') || ''; } } catch (e) { b.s = 1; b.r = document.referrer || ''; }
    try { if (localStorage.getItem('vr_sv_d') !== d) { localStorage.setItem('vr_sv_d', d); b.v = 1; } if (!localStorage.getItem('vr_sv_f')) { localStorage.setItem('vr_sv_f', d); b.n = 1; } } catch (e) { }
    send(b);
    if (bot) return;
    // время на странице: считаем только пока вкладка видна; отправляем один раз при уходе
    var shown = document.visibilityState === 'visible' ? Date.now() : 0, total = 0, sent = false;
    var flush = function () {
      if (shown) { total += Date.now() - shown; shown = 0; }
      if (sent) return; var t = Math.round(total / 1000); if (t < 1) return;
      sent = true; send({ u: location.pathname, t: Math.min(t, 1800) });
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(); else if (!sent) shown = Date.now();
    });
    window.addEventListener('pagehide', flush);
  } catch (e) { }
})();
