// Замена ffmpeg "-frames:v 1 -vf scale=W:-1" (миниатюра) и _probe_ok/_clip_valid.
import { vfs } from './core.js';

function loadMedia(blob, isVideo) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob);
    const done = (v, e) => { if (!isVideo) { } res2(v, e); };
    let fin = false; const res2 = (v, e) => { if (fin) return; fin = true; clearTimeout(to); if (e) { URL.revokeObjectURL(u); rej(e); } else res({ el: v, url: u }); };
    const to = setTimeout(() => res2(null, new Error('таймаут декодирования')), 20000);
    if (isVideo) {
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = () => done(v); v.onerror = () => res2(null, new Error('видео не декодируется'));
      v.src = u;
    } else {
      const im = new Image(); im.onload = () => done(im); im.onerror = () => res2(null, new Error('картинка не декодируется')); im.src = u;
    }
  });
}
function seek(v, t) { return new Promise(r => { if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) { r(); return; } const f = () => { v.removeEventListener('seeked', f); r(); }; v.addEventListener('seeked', f); v.currentTime = t; setTimeout(r, 3000); }); }

export async function makeThumb(src, dst, width = 240, at = 0) {
  const blob = typeof src === 'string' ? vfs.read(src) : src;
  if (!blob) throw new Error('нет файла');
  const isVideo = /^video\//.test(blob.type) || (typeof src === 'string' && /\.(mp4|mov|mkv|webm|avi)$/i.test(src));
  const { el, url } = await loadMedia(blob, isVideo);
  try {
    if (isVideo) await seek(el, Math.min(at, Math.max(0, (el.duration || 0) - 0.05)));
    const w0 = isVideo ? el.videoWidth : el.naturalWidth, h0 = isVideo ? el.videoHeight : el.naturalHeight;
    if (!w0 || !h0) throw new Error('пустой кадр');
    const w = width, h = Math.max(2, Math.round(h0 * width / w0));
    const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(el, 0, 0, w, h);
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    vfs.write(dst, out); await vfs.flush(dst);
    return true;
  } finally { URL.revokeObjectURL(url); }
}
// _probe_ok: реально декодируемое медиа (есть кадр с шириной; у видео длительность ≥0.1с)
export async function probeOk(p, isVideo) {
  const blob = typeof p === 'string' ? vfs.read(p) : p;
  if (!blob || blob.size < 512) return false;
  try {
    const { el, url } = await loadMedia(blob, isVideo);
    URL.revokeObjectURL(url);
    if (isVideo) return el.videoWidth > 0 && (el.duration || 0) >= 0.1;
    return el.naturalWidth > 0;
  } catch (e) { return false; }
}
export async function mediaInfo(p) {
  const blob = typeof p === 'string' ? vfs.read(p) : p;
  const isVideo = /^video\//.test(blob.type) || (typeof p === 'string' && /\.(mp4|mov|mkv|webm|avi)$/i.test(p));
  const { el, url } = await loadMedia(blob, isVideo); URL.revokeObjectURL(url);
  return isVideo ? { w: el.videoWidth, h: el.videoHeight, dur: el.duration || 0, isVideo } : { w: el.naturalWidth, h: el.naturalHeight, dur: 0, isVideo };
}
