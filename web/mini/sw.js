// Видеорилс Мини (веб): «локальный http-сервер» как у pywebview. Отдаёт файлы
// виртуальной ФС (temp/, output/, assets/voice_demos/ …) из Cache Storage по тем же
// относительным URL, что и десктоп, с поддержкой Range (перемотка <video>).
const VFS_CACHE = 'vr-vfs-v1';
const VFS_PREFIXES = ['temp/', 'output/', 'input/', 'assets/voice_demos/', 'assets/user/'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function relOf(url) {
  const base = new URL('./', self.registration.scope).href;
  return url.startsWith(base) ? url.slice(base.length) : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const rel = relOf(u.origin + u.pathname);
  if (rel === null || !VFS_PREFIXES.some(p => rel.startsWith(p))) return;
  event.respondWith(serve(u.origin + u.pathname, req, event.clientId, rel));
});

// Файла нет в Cache Storage (браузер не дал места — запись молча отбрасывается) ->
// берём его прямо из памяти страницы: ролик/превью/миниатюры работают и без хранилища.
async function fromPage(clientId, rel) {
  try {
    const list = clientId ? [await self.clients.get(clientId)] : await self.clients.matchAll({ type: 'window' });
    for (const c of list) {
      if (!c) continue;
      const blob = await new Promise((res) => { const ch = new MessageChannel(); const t = setTimeout(() => res(null), 4000);
        ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data || null); }; c.postMessage({ type: 'vfs-get', path: rel }, [ch.port2]); });
      if (blob) return new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
    }
  } catch (e) { }
  return null;
}

async function serve(key, req, clientId, rel) {
  const cache = await caches.open(VFS_CACHE);
  let r = await cache.match(key);
  // запись в кэш асинхронна — даём ей догнать (обычно миллисекунды)
  for (let i = 0; !r && i < 10; i++) { await new Promise(s => setTimeout(s, 100)); r = await cache.match(key); }
  if (!r) r = await fromPage(clientId, rel);
  if (!r) return new Response('not found', { status: 404 });
  const range = req.headers.get('range');
  const type = r.headers.get('Content-Type') || 'application/octet-stream';
  if (!range) {
    const b = await r.blob();
    return new Response(b, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(b.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
  }
  const b = await r.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : b.size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, b.size - parseInt(m[2], 10)); end = b.size - 1; }
  end = Math.min(end, b.size - 1);
  if (start > end || start >= b.size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${b.size}` } });
  return new Response(b.slice(start, end + 1, type), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${b.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
  });
}
