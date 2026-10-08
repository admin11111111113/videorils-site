// Видеорилс — посредник Edge-TTS для веб-версии. Microsoft пускает websocket «Read aloud»
// только с User-Agent браузера Edge; из Chrome/Safari/Firefox сайт его подменить не может.
// Worker пересылает websocket 1:1 (те же speech.config/SSML/audio, что у edge_tts), подставляя UA.
const UPSTREAM = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const ALLOWED = [/^https:\/\/(www\.)?videorils\.com$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    if (!ALLOWED.some(r => r.test(origin))) return new Response('forbidden', { status: 403 });
    if (url.pathname !== '/edge' || req.headers.get('Upgrade') !== 'websocket') return new Response('ok', { status: 200 });
    const up = await fetch(UPSTREAM + url.search, {
      headers: { Upgrade: 'websocket', 'User-Agent': EDGE_UA, Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
    });
    const ws = up.webSocket;
    if (!ws) return new Response('upstream ' + up.status, { status: 502 });
    ws.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // двоичные кадры (аудио) приходят Blob'ами — переводим в ArrayBuffer, порядок держим цепочкой
    const relay = (dst) => { let chain = Promise.resolve(); return (e) => { const d = e.data;
      chain = chain.then(async () => { try { dst.send(d instanceof Blob ? await d.arrayBuffer() : d); } catch (x) { } }); }; };
    server.addEventListener('message', relay(ws));
    ws.addEventListener('message', relay(server));
    const closeBoth = (code, reason) => { try { server.close(code || 1000, reason || ''); } catch (x) { } try { ws.close(code || 1000, reason || ''); } catch (x) { } };
    server.addEventListener('close', (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
    ws.addEventListener('close', (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
    server.addEventListener('error', () => closeBoth(1011)); ws.addEventListener('error', () => closeBoth(1011));
    return new Response(null, { status: 101, webSocket: client });
  },
};
