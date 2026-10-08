// Кадры ИСХОДНОГО видео («Кадры из этого видео») — замена _cover916 + ffmpeg -ss -frames:v 1.
//   blur=true  — весь кадр вписан + размытая подложка по краям (letterbox, gblur sigma=min(W,H)/40)
//   blur=false — центр-кроп (заполнить и обрезать); zoom=true — ещё зум 92% («Скрыть надписи»)
import { vfs } from './core.js';

// рисует кадр src (sw×sh) в W×H по правилам _cover916
export function drawFit(ctx, src, sw, sh, W, H, { blur = false, zoom = false } = {}) {
  const draw = (x, y, w, h) => { if (src.draw) src.draw(ctx, x, y, w, h); else ctx.drawImage(src, x, y, w, h); };
  if (blur) {
    const sig = Math.max(10, Math.trunc(Math.min(1080, 1920) / 40)) * (Math.min(W, H) / 1080);
    const sc = Math.max(W / sw, H / sh), dw = sw * sc, dh = sh * sc;
    ctx.save(); ctx.filter = `blur(${sig.toFixed(1)}px)`;
    // края размытия не должны «просвечивать» чёрным — рисуем подложку чуть шире кадра
    const pad = sig * 2; draw((W - dw) / 2 - pad, (H - dh) / 2 - pad, dw + 2 * pad, dh + 2 * pad);
    ctx.restore();
    const fc = Math.min(W / sw, H / sh), fw = sw * fc, fh = sh * fc;
    draw((W - fw) / 2, (H - fh) / 2, fw, fh);
    return;
  }
  let sc = Math.max(W / sw, H / sh);
  if (zoom) sc = sc / 0.92;          // crop=iw*0.92:ih*0.92 -> scale обратно
  const dw = sw * sc, dh = sh * sc;
  draw((W - dw) / 2, (H - dh) / 2, dw, dh);
}

function loadVideo(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob);
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
    const to = setTimeout(() => { URL.revokeObjectURL(u); rej(new Error('таймаут декодирования')); }, 20000);
    v.onloadeddata = () => { clearTimeout(to); res({ v, u }); };
    v.onerror = () => { clearTimeout(to); URL.revokeObjectURL(u); rej(new Error('видео не декодируется')); };
    v.src = u;
  });
}
function seek(v, t) { return new Promise(r => { const f = () => { v.removeEventListener('seeked', f); r(); }; v.addEventListener('seeked', f); v.currentTime = t; setTimeout(r, 4000); }); }

const DUR = new Map();   // ffprobe_duration-кэш по пути+размеру
export async function mediaDur(p) {
  const b = typeof p === 'string' ? vfs.read(p) : p; if (!b) return 0;
  const k = (typeof p === 'string' ? p : '') + '|' + b.size;
  if (DUR.has(k)) return DUR.get(k);
  const { v, u } = await loadVideo(b);
  let d = v.duration;
  if (!isFinite(d)) { v.currentTime = 1e9; await new Promise(r => setTimeout(r, 300)); d = v.duration; }
  URL.revokeObjectURL(u);
  d = isFinite(d) ? d : 0; DUR.set(k, d); return d;
}

// один кадр исходника в момент at -> JPEG W×H в VFS (out)
export async function frameAt(src, at, out, { W = 1080, H = 1920, blur = false, zoom = false, quality = 0.85 } = {}) {
  const blob = typeof src === 'string' ? vfs.read(src) : src;
  if (!blob) throw new Error('нет файла');
  const { v, u } = await loadVideo(blob);
  try {
    await seek(v, Math.max(0, Math.min(at, (v.duration || at) - 0.05)));
    if (!v.videoWidth) throw new Error('пустой кадр');
    const c = new OffscreenCanvas(W, H); const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    drawFit(ctx, v, v.videoWidth, v.videoHeight, W, H, { blur, zoom });
    const b = await c.convertToBlob({ type: 'image/jpeg', quality });
    vfs.write(out, b); await vfs.flush(out);
    return out;
  } finally { URL.revokeObjectURL(u); }
}

// _detect_outro: застывшая концовка (лого/заставка) на последних ~10с — freezedetect n=-55dB d=0.6.
// Доверяем, только если фриз доходит почти до конца и длится 0.8..8с. 0 — не найдено.
export async function detectOutro(src, dur) {
  try {
    const blob = typeof src === 'string' ? vfs.read(src) : src; if (!blob) return 0.0;
    const win = Math.min(10.0, Math.max(2.0, dur)); const ss = Math.max(0.0, dur - win);
    const { v, u } = await loadVideo(blob);
    try {
      const c = new OffscreenCanvas(64, 114); const ctx = c.getContext('2d', { willReadFrequently: true });
      const step = 0.1; let prev = null; let freezeStart = null; const NOISE = 255 * Math.pow(10, -55 / 20) * 4;   // -55dB ≈ шум кадра
      for (let t = ss; t <= dur - 0.05; t += step) {
        await seek(v, t); ctx.drawImage(v, 0, 0, 64, 114);
        const d = ctx.getImageData(0, 0, 64, 114).data; const g = new Float32Array(64 * 114);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (prev) {
          let m = 0; for (let j = 0; j < g.length; j++) m += Math.abs(g[j] - prev[j]); m /= g.length;
          if (m <= NOISE) { if (freezeStart === null) freezeStart = t - step; } else freezeStart = null;
        }
        prev = g;
      }
      if (freezeStart === null) return 0.0;
      const outro = dur - freezeStart;
      if (outro >= 0.8 && outro <= Math.min(8.0, win + 0.5)) return Math.round(outro * 10) / 10;
    } finally { URL.revokeObjectURL(u); }
  } catch (e) { }
  return 0.0;
}
