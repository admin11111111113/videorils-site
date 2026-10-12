/* Своя статистика сайта videorils.com: анонимные счётчики (просмотр, визит, источник, страница). Без cookies и без личных данных. */
(function () {
  try {
    if (!/(^|\.)videorils\.com$/.test(location.hostname)) return;
    var d = new Date().toISOString().slice(0, 10), b = { u: location.pathname };
    try { if (!sessionStorage.getItem('vr_sv_s')) { sessionStorage.setItem('vr_sv_s', '1'); b.s = 1; b.r = document.referrer || ''; var q = new URLSearchParams(location.search); b.utm = q.get('utm_source') || ''; } } catch (e) { b.s = 1; b.r = document.referrer || ''; }
    try { if (localStorage.getItem('vr_sv_d') !== d) { localStorage.setItem('vr_sv_d', d); b.v = 1; } if (!localStorage.getItem('vr_sv_f')) { localStorage.setItem('vr_sv_f', d); b.n = 1; } } catch (e) { }
    var body = JSON.stringify(b), url = 'https://videorils-tts.videorils.workers.dev/site/ev';
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    else fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: body });
  } catch (e) { }
})();
