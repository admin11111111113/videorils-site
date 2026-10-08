// Аудио-примитивы вместо ffmpeg/ffprobe для звука (декод, ресемпл, WAV, склейка,
// тишина, atempo, громкость/afade). Всё на Web Audio API.
import { vfs } from './core.js';

let _ctx = null;
function ctx() { if (!_ctx) _ctx = new (self.AudioContext || self.webkitAudioContext)(); return _ctx; }

export async function decode(blobOrPath) {
  const b = typeof blobOrPath === 'string' ? vfs.read(blobOrPath) : blobOrPath;
  if (!b) throw new Error('нет файла: ' + blobOrPath);
  const ab = await b.arrayBuffer();
  return await ctx().decodeAudioData(ab.slice(0));
}
// ffprobe_duration для аудио/видео (видео — через <video> metadata)
export async function duration(pathOrBlob) {
  try {
    const b = typeof pathOrBlob === 'string' ? vfs.read(pathOrBlob) : pathOrBlob;
    if (!b || !b.size) return 0.0;
    const t = (b.type || '');
    if (t.startsWith('audio') || /\.(mp3|wav|m4a|aac|ogg|webm|opus)$/i.test(String(pathOrBlob))) {
      try { const buf = await decode(b); return buf.duration; } catch (e) { /* видео-контейнер — ниже */ }
    }
    return await mediaElementDuration(b);
  } catch (e) { return 0.0; }
}
export function mediaElementDuration(blob) {
  return new Promise((res) => {
    const el = document.createElement('video'); el.preload = 'metadata'; el.muted = true;
    const u = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(0);
    setTimeout(() => done(0), 15000);
    el.src = u;
  });
}
export async function resample(buf, sr = 44100, ch = 1) {
  const len = Math.max(1, Math.ceil(buf.duration * sr));
  const oc = new OfflineAudioContext(ch, len, sr);
  const s = oc.createBufferSource(); s.buffer = buf; s.connect(oc.destination); s.start();
  return await oc.startRendering();
}
export function silence(sec, sr = 44100, ch = 1) {
  return new AudioBuffer({ length: Math.max(1, Math.round(sec * sr)), numberOfChannels: ch, sampleRate: sr });
}
export function concat(bufs, sr = 44100, ch = 1) {
  const total = bufs.reduce((a, b) => a + b.length, 0);
  const out = new AudioBuffer({ length: Math.max(1, total), numberOfChannels: ch, sampleRate: sr });
  let off = 0;
  for (const b of bufs) {
    for (let c = 0; c < ch; c++) out.getChannelData(c).set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), off);
    off += b.length;
  }
  return out;
}
export function slice(buf, t0, t1) {
  const sr = buf.sampleRate; const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(buf.length, Math.max(a + 1, Math.floor(t1 * sr)));
  const out = new AudioBuffer({ length: Math.max(1, b - a), numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(a, b));
  return out;
}
export function wav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true); o += 2; }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}
export async function toWav(blob, sr = 44100, ch = 1) { return wav(await resample(await decode(blob), sr, ch)); }
// atempo: ускорение/замедление БЕЗ смены тона (WSOLA) — как ffmpeg atempo.
export function atempo(buf, factor) {
  if (Math.abs(factor - 1) < 1e-3) return buf;
  const sr = buf.sampleRate, ch = buf.numberOfChannels;
  const win = Math.round(sr * 0.03), hopOut = Math.round(win / 2), hopIn = hopOut * factor, search = Math.round(sr * 0.012);
  const nOut = Math.max(1, Math.round(buf.length / factor));
  const out = new AudioBuffer({ length: nOut + win, numberOfChannels: ch, sampleRate: sr });
  const hann = new Float32Array(win); for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
  const src = []; const dst = []; for (let c = 0; c < ch; c++) { src.push(buf.getChannelData(c)); dst.push(out.getChannelData(c)); }
  const norm = new Float32Array(nOut + win);
  let prevPos = 0;
  for (let o = 0, k = 0; o < nOut; o += hopOut, k++) {
    let pos = Math.round(k * hopIn);
    if (k > 0) {   // ищем лучшее совпадение с естественным продолжением прошлого окна
      const nat = prevPos + hopOut; let best = pos, bestC = -Infinity;
      for (let d = -search; d <= search; d += 2) {
        const p = pos + d; if (p < 0 || p + win >= buf.length || nat + win >= buf.length) continue;
        let c = 0; const s0 = src[0]; for (let i = 0; i < win; i += 4) c += s0[p + i] * s0[nat + i];
        if (c > bestC) { bestC = c; best = p; }
      }
      pos = best;
    }
    if (pos + win >= buf.length) pos = Math.max(0, buf.length - win - 1);
    for (let c = 0; c < ch; c++) for (let i = 0; i < win; i++) dst[c][o + i] += src[c][pos + i] * hann[i];
    for (let i = 0; i < win; i++) norm[o + i] += hann[i];
    prevPos = pos;
  }
  for (let c = 0; c < ch; c++) for (let i = 0; i < nOut; i++) if (norm[i] > 1e-3) dst[c][i] /= norm[i];
  return slice(out, 0, nOut / sr);
}
export const dbToGain = (db) => Math.pow(10, db / 20);
