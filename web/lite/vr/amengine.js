// Автомонтаж (Лайт) — анализ кадров и ОДНОПРОХОДНЫЙ рендер эффектов поверх готового видео.
// В приложении каждый эффект — отдельный проход ffmpeg (cut -> lens -> b-roll -> zoom/tilt ->
// иконки -> ч/б камера -> эмодзи -> субтитры -> звуки); здесь те же эффекты в том же порядке
// накладываются на каждый кадр за один проход кодирования.
import { vfs } from './core.js';
import { cssFont, loadFonts } from './fonts.js';
import { AssRenderer } from './ass_render.js';
import * as A from './audio.js';

let MB = null;
async function mb() { if (!MB) MB = await import('./lib/mediabunny.min.mjs'); return MB; }
const W = 1080, H = 1920, FPS = 30;

// ---------- выборка кадров видео (замена ffmpeg -vf fps=..,scale=..) ----------
export async function sampleFrames(blob, times, w, h, gray = false) {
  const M = await mb();
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack(); if (!vt) return [];
  const sink = new M.VideoSampleSink(vt);
  const c = new OffscreenCanvas(w, h); const ctx = c.getContext('2d', { willReadFrequently: true });
  const out = [];
  try {
    for await (const s of sink.samplesAtTimestamps(times)) {
      if (!s) { out.push(null); continue; }
      ctx.drawImage(s.toCanvasImageSource ? s.toCanvasImageSource() : s, 0, 0, w, h); s.close();
      const d = ctx.getImageData(0, 0, w, h).data;
      if (gray) { const g = new Int16Array(w * h); for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); out.push(g); }
      else out.push(new Uint8ClampedArray(d));
    }
  } finally { try { input.dispose && input.dispose(); } catch (e) { } }
  return out;
}
export async function videoDur(blob) {
  const M = await mb(); const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  try { const vt = await input.getPrimaryVideoTrack(); return vt ? await vt.computeDuration() : 0; } finally { try { input.dispose && input.dispose(); } catch (e) { } }
}

// ---------- детектор лиц ultraface (320x240) через onnxruntime-web ----------
let _ort = null, _sess = null;
export async function faceSession(modelUrl) {
  if (_sess !== null) return _sess;
  try {
    if (!_ort) { _ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1/+esm'); _ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/'; _ort.env.logLevel = 'error'; }
    const buf = await (await fetch(modelUrl)).arrayBuffer();
    _sess = await _ort.InferenceSession.create(buf, { executionProviders: ['wasm'], logSeverityLevel: 3 });
  } catch (e) { console.warn('face model', e); _sess = false; }
  return _sess;
}
export async function faceRun(sess, rgba) {   // rgba 320x240 -> [{score, box[4]}]
  const N = 320 * 240; const x = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) { x[i] = (rgba[i * 4] - 127) / 128; x[N + i] = (rgba[i * 4 + 1] - 127) / 128; x[2 * N + i] = (rgba[i * 4 + 2] - 127) / 128; }
  const name = sess.inputNames[0];
  const res = await sess.run({ [name]: new _ort.Tensor('float32', x, [1, 3, 240, 320]) });
  const outs = sess.outputNames.map(n => res[n]);
  const conf = outs.find(t => t.dims[t.dims.length - 1] === 2), boxes = outs.find(t => t.dims[t.dims.length - 1] === 4);
  const n = conf.dims[1]; const out = [];
  for (let i = 0; i < n; i++) out.push({ score: conf.data[i * 2 + 1], box: [boxes.data[i * 4], boxes.data[i * 4 + 1], boxes.data[i * 4 + 2], boxes.data[i * 4 + 3]] });
  return out;
}

// ---------- кривые движения камеры (_AM_ZOOM_MOTION) ----------
export function motionTerm(motion, value, t, T, w) {
  if (motion === 'linear') return value * Math.max(0, 1 - Math.abs(T - t) / w);
  return value * Math.exp(-Math.pow((T - t) / w, 2));      // crash / ease — колокол
}
// _slide_xy: заезд за ti, держится, выезд за to; вне окна — за кадром
export function slideXY(direction, S, dur, ti, to, hx, hy, t, w, h) {
  const E = S + dur, Si = S + ti, Eo = E - to;
  const mv = (home, off) => t < S ? off : (t < Si ? off + (home - off) * (t - S) / ti : (t < Eo ? home : (t < E ? home + (off - home) * (t - Eo) / to : off)));
  if (direction === 'top') return [hx, mv(hy, -h)];
  if (direction === 'bottom') return [hx, mv(hy, H)];
  if (direction === 'left') return [mv(hx, -w), hy];
  return [mv(hx, W), hy];
}

// ---------- поток кадров вставки (setpts=PTS-STARTPTS+st, -stream_loop) ----------
class ClipStream {
  constructor(spec) { this.spec = spec; this.it = null; this.bmp = null; this.input = null; }
  async open(st, nFrames) {
    if (this.spec.kind === 'image') { this.bmp = await createImageBitmap(this.spec.blob); return; }
    const M = await mb(); this.input = new M.Input({ source: new M.BlobSource(this.spec.blob), formats: M.ALL_FORMATS });
    const vt = await this.input.getPrimaryVideoTrack(); const d = Math.max(0.05, await vt.computeDuration());
    const sink = new M.VideoSampleSink(vt);
    const times = []; for (let i = 0; i < nFrames; i++) { let t = i / FPS; if (t >= d) t = t % d; times.push(t); }
    this.it = sink.samplesAtTimestamps(times)[Symbol.asyncIterator]();
  }
  async next() { if (this.bmp) return this.bmp; if (!this.it) return null; const r = await this.it.next(); return r.done ? null : r.value; }
  close() { try { this.input && this.input.dispose && this.input.dispose(); } catch (e) { } if (this.bmp) { try { this.bmp.close(); } catch (e) { } } }
}
function drawCoverRect(ctx, src, sw, sh, x, y, w, h) {
  const sc = Math.max(w / sw, h / sh); const dw = sw * sc, dh = sh * sc;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
}
const srcOf = (s) => (s && s.toCanvasImageSource) ? s.toCanvasImageSource() : s;
const dimsOf = (s) => (s && s.displayWidth) ? [s.displayWidth, s.displayHeight] : [s.width, s.height];

/**
 * renderAutomontage(spec):
 *  base: Blob (am_base 1080x1920), keep: [[s,e]] (участки исходника после вырезок), seams: [t],
 *  lens: {track:[[t,x,y]], wins:[{t,dur}]|null, D, C}, broll: [{t,dur,layout,clip:{kind,blob}}],
 *  zoom: {zooms:[[t,a,m,w]], tilts:[[t,rad,m,w]], comp:[[t,need,m,w]], cap},
 *  icons: [{img, x, s, e}], bw: {wins|null, frame, dot}, emoji: [{img, s, e}], ass, sfx: [{buf, start, vol}],
 *  seamAmp, seamWide, seamNarrow, seamSigma:[a,b], splitTop, splitBot, splitBorder, onProgress
 */
export async function renderAutomontage(spec) {
  const M = await mb(); await loadFonts();
  const sr = 44100;
  // ---- звук: исходник по участкам keep (atrim+concat) + звуки переходов (adelay, volume, amix first) ----
  let base_audio;
  try { base_audio = await A.resample(await A.decode(spec.base), sr, 2); } catch (e) { base_audio = null; }
  const parts = spec.keep.map(([s, e]) => base_audio ? A.slice(base_audio, s, e) : A.silence(e - s, sr, 2));
  let audio = A.concat(parts, sr, 2);
  const totalDur = spec.keep.reduce((a, [s, e]) => a + (e - s), 0);
  if (spec.sfx && spec.sfx.length && base_audio) {
    for (const f of spec.sfx) {
      const b = await A.resample(f.buf, sr, 2); const off = Math.round(f.start * sr);
      for (let ch = 0; ch < 2; ch++) { const o = audio.getChannelData(ch), d = b.getChannelData(ch); for (let i = 0; i < d.length && off + i < o.length; i++) o[off + i] += d[i] * f.vol; }
    }
  }
  // ---- кодеры ----
  const vcodec = (await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H })) || 'avc';
  const acodec = (await M.getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac';
  const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d', { alpha: false });
  const tmp = new OffscreenCanvas(W, H); const tctx = tmp.getContext('2d');
  const output = new M.Output({ format: vcodec === 'avc' ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(), target: new M.BufferTarget() });
  const vsrc = new M.CanvasSource(canvas, { codec: vcodec, bitrate: 8e6, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  const asrc = new M.AudioBufferSource({ codec: acodec, bitrate: 192e3 }); output.addAudioTrack(asrc);
  await output.start();
  const nF = Math.max(1, Math.round(totalDur * FPS));
  // время выхода -> время исходника (по участкам keep)
  const cum = []; { let a = 0; for (const [s, e] of spec.keep) { cum.push(a); a += e - s; } }
  const mapT = (t) => { for (let i = spec.keep.length - 1; i >= 0; i--) if (t >= cum[i] - 1e-9) return Math.min(spec.keep[i][1] - 0.001, spec.keep[i][0] + (t - cum[i])); return 0; };
  const M2 = await mb(); const inp = new M2.Input({ source: new M2.BlobSource(spec.base), formats: M2.ALL_FORMATS });
  const vt = await inp.getPrimaryVideoTrack(); const sink = new M2.VideoSampleSink(vt);
  const times = []; for (let k = 0; k < nF; k++) times.push(mapT(k / FPS));
  const ass = spec.ass ? new AssRenderer(spec.ass) : null;
  // вставки: открываем поток в момент начала окна, закрываем после конца
  const brolls = (spec.broll || []).map((b, k) => Object.assign({ k, stream: null, done: false }, b));
  const lensC = spec.lens ? new OffscreenCanvas(spec.lens.D, spec.lens.D) : null;
  const inWins = (wins, t) => !wins || !wins.length || wins.some(w => t >= w.t && t <= w.t + w.dur);
  const lensPos = (t) => { const tr = spec.lens.track; let p = tr[0]; for (const q of tr) { if (q[0] <= t) p = q; else break; } return p; };
  let k = 0;
  try {
    for await (const s of sink.samplesAtTimestamps(times)) {
      const tc = k / FPS;
      // 1) база + смаз на стыках вырезок (zoompan crash + gblur в окнах)
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      let zs = 1;
      if (spec.seams && spec.seams.length) { let sum = 0; for (const j of spec.seams) sum += motionTerm('crash', spec.seamAmp, j, tc, 0.07); zs = Math.min(1 + spec.seamAmp, 1 + sum); }
      if (s) {
        const [sw, sh] = dimsOf(s); const dw = W * zs, dh = H * zs;
        let blur = 0;
        if (spec.seams) for (const j of spec.seams) { if (Math.abs(tc - j) <= spec.seamWide) blur = Math.max(blur, spec.seamSigma[0]); if (Math.abs(tc - j) <= spec.seamNarrow) blur = Math.max(blur, Math.hypot(spec.seamSigma[0], spec.seamSigma[1])); }
        ctx.save(); if (blur) ctx.filter = `blur(${blur}px)`;
        ctx.drawImage(srcOf(s), 0, 0, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh); ctx.restore(); s.close();
      }
      // 2) лупа за курсором
      if (spec.lens && inWins(spec.lens.wins, tc)) {
        const [, x, y] = lensPos(tc); const { D, C } = spec.lens;
        const cx = Math.max(0, Math.min(W - C, Math.trunc(x - C / 2))), cy = Math.max(0, Math.min(H - C, Math.trunc(y - C / 2)));
        const ox = Math.max(0, Math.min(W - D, Math.trunc(x - D / 2))), oy = Math.max(0, Math.min(H - D, Math.trunc(y - D / 2)));
        const l = lensC.getContext('2d'); l.clearRect(0, 0, D, D); l.save(); l.beginPath(); l.ellipse(D / 2, D / 2, D / 2, D / 2, 0, 0, Math.PI * 2); l.clip();
        l.imageSmoothingQuality = 'high'; l.drawImage(canvas, cx, cy, C, C, 0, 0, D, D); l.restore();
        ctx.drawImage(lensC, ox, oy);
        ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.beginPath(); ctx.ellipse(ox + D / 2, oy + D / 2, D / 2 - 4.5, D / 2 - 4.5, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(ox + D / 2, oy + D / 2, D / 2 - 8, D / 2 - 8, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      // 3) вставки b-roll: split (сверху сток 1080x672 с окантовкой, снизу центр оригинала) | full (заезд)
      for (const b of brolls) {
        if (b.done) continue;
        const fullSlide = b.layout !== 'split';
        if (tc < b.t || tc > b.t + b.dur + (fullSlide ? 0 : 0)) { if (tc > b.t + b.dur && b.stream) { b.stream.close(); b.stream = null; b.done = true; } continue; }
        if (!b.stream) { b.stream = new ClipStream(b.clip); try { await b.stream.open(0, Math.ceil((b.dur + 0.6) * FPS)); } catch (e) { b.done = true; continue; } }
        const fr = await b.stream.next(); if (!fr) continue;
        const [fw, fh] = dimsOf(fr);
        if (!fullSlide) {
          tctx.drawImage(canvas, 0, 0);
          ctx.drawImage(tmp, 0, (H - spec.splitBot) / 2, W, spec.splitBot, 0, spec.splitTop, W, spec.splitBot);
          drawCoverRect(ctx, srcOf(fr), fw, fh, 0, 0, W, spec.splitTop);
          ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = spec.splitBorder; ctx.strokeRect(spec.splitBorder / 2, spec.splitBorder / 2, W - spec.splitBorder, spec.splitTop - spec.splitBorder); ctx.restore();
        } else {
          const DIRS = ['left', 'right', 'top', 'bottom'];
          const [xe, ye] = slideXY(DIRS[b.k % 4], b.t, b.dur, 0.28, 0.28, 0, 0, tc, W, H);
          drawCoverRect(ctx, srcOf(fr), fw, fh, xe, ye, W, H);
        }
        if (fr !== b.stream.bmp && fr.close) fr.close();
      }
      // 4) наезды / наклоны камеры (zoompan по центру + rotate, края — чёрные)
      if (spec.zoom) {
        const Z = spec.zoom; let sum = 0;
        for (const [t, a, m, w] of Z.zooms) sum += motionTerm(m, a, t, tc, w);
        for (const [t, need, m, w] of Z.comp) sum += motionTerm(m, need, t, tc, w);
        const z = Math.min(Z.cap, 1 + sum); let rot = 0;
        for (const [t, rad, m, w] of Z.tilts) rot += motionTerm(m, rad, t, tc, w);
        if (z > 1.0005 || Math.abs(rot) > 1e-4) {
          tctx.drawImage(canvas, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.save(); ctx.translate(W / 2, H / 2); if (rot) ctx.rotate(rot); ctx.scale(z, z); ctx.drawImage(tmp, -W / 2, -H / 2); ctx.restore();
        }
      }
      // 5) иконки платформ (заезд сверху)
      for (const ic of (spec.icons || [])) {
        if (tc < ic.s || tc > ic.e) continue;
        const dur = Math.max(0.3, ic.e - ic.s); const ti = Math.min(0.22, Math.max(0.08, dur / 2 - 0.04));
        const iw = 176, ih = Math.round(ic.img.height * 176 / ic.img.width);
        const [xe, ye] = slideXY('top', ic.s, dur, ti, ti, ic.x, 150, tc, iw, ih); ctx.drawImage(ic.img, xe, ye, iw, ih);
      }
      // 6) ч/б «съёмка на камеру»: серый + зерно + виньетка + уголки + REC + 4K 60FPS
      if (spec.bw && inWins(spec.bw.wins, tc)) {
        tctx.drawImage(canvas, 0, 0); ctx.save(); ctx.filter = 'grayscale(1)'; ctx.drawImage(tmp, 0, 0); ctx.restore();
        const im = ctx.getImageData(0, 0, W, H); const d = im.data;
        for (let i = 0; i < d.length; i += 4) { const nv = (Math.random() * 2 - 1) * 8; d[i] += nv; d[i + 1] += nv; d[i + 2] += nv; }
        ctx.putImageData(im, 0, 0);
        ctx.drawImage(spec.bw.vig, 0, 0);
        if (spec.bw.frame) ctx.drawImage(spec.bw.frame, 0, 0, W, H);
        if (spec.bw.dot && (tc % 1.8) < 1.1) ctx.drawImage(spec.bw.dot, 70, 104);
        ctx.save(); ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
        ctx.font = cssFont('Arial Black', 44); ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText('REC', 128, 100); ctx.fillStyle = '#fff'; ctx.fillText('REC', 128, 100);
        ctx.font = cssFont('Arial Black', 40); const tw = ctx.measureText('4K 60FPS').width; ctx.strokeText('4K 60FPS', W - tw - 70, 104); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText('4K 60FPS', W - tw - 70, 104);
        ctx.restore();
      }
      // 7) эмодзи (заезд справа, x=W-w-42, y=290)
      for (const em of (spec.emoji || [])) {
        if (tc < em.s || tc > em.e) continue;
        const dur = Math.max(0.3, em.e - em.s); const ti = Math.min(0.22, Math.max(0.08, dur / 2 - 0.04));
        const [xe, ye] = slideXY('right', em.s, dur, ti, ti, W - em.img.width - 42, 290, tc, em.img.width, em.img.height); ctx.drawImage(em.img, xe, ye);
      }
      // 8) субтитры
      if (ass) ass.draw(ctx, tc);
      await vsrc.add(k / FPS, 1 / FPS);
      if (k % 15 === 0 && spec.onProgress) spec.onProgress(k / nF);
      k++; if (k >= nF) break;
    }
  } finally { for (const b of brolls) if (b.stream) b.stream.close(); try { inp.dispose && inp.dispose(); } catch (e) { } }
  for (; k < nF; k++) { await vsrc.add(k / FPS, 1 / FPS); }
  vsrc.close();
  let aud = audio; const need = nF / FPS;
  if (aud.duration < need - 0.005) aud = A.concat([aud, A.silence(need - aud.duration, sr, 2)], sr, 2); else aud = A.slice(aud, 0, need);
  await asrc.add(aud); asrc.close();
  await output.finalize();
  return { blob: new Blob([output.target.buffer], { type: vcodec === 'avc' ? 'video/mp4' : 'video/webm' }), duration: need, ext: vcodec === 'avc' ? '.mp4' : '.webm' };
}
// виньетка vignette=PI/5: множитель cos(a·r)^4 к краям (r — доля расстояния до угла)
export function vignetteCanvas() {
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  const g = x.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W / 2, H / 2));
  for (let i = 0; i <= 10; i++) { const r = i / 10; const f = Math.pow(Math.cos(Math.PI / 5 * r), 4); g.addColorStop(r, `rgba(0,0,0,${(1 - f).toFixed(3)})`); }
  x.fillStyle = g; x.fillRect(0, 0, W, H); return c;
}
