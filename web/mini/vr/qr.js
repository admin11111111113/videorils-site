// QR как в app.py (_qr_image): border=1, коррекция M, тёмно-синий (20,22,40) на белом, NEAREST.
let _lib = null;
async function lib() { if (!_lib) _lib = (await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm')).default; return _lib; }
export async function qrCanvas(text, px) {
  const qrcode = await lib();
  const q = qrcode(0, 'M'); q.addData(unescape(encodeURIComponent(text || ''))); q.make();
  const n = q.getModuleCount(); const border = 1; const total = n + border * 2;
  const c = new OffscreenCanvas(px, px); const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
  g.fillStyle = 'rgb(20,22,40)';
  const s = px / total;
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect(Math.floor((k + border) * s), Math.floor((r + border) * s), Math.ceil(s), Math.ceil(s));
  return c;
}
export async function qrDataUrl(text, px = 320) {
  const c = await qrCanvas(text, px); const b = await c.convertToBlob({ type: 'image/png' });
  return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}
