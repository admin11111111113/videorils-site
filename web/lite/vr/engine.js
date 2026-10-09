// Видеодвижок веб-версии (WebCodecs через mediabunny) — делает ТО ЖЕ, что цепочка ffmpeg
// десктопа, но за ОДИН проход кодирования:
//   rclip_i (cover-crop 9:16 / blur-letterbox + loop / Ken Burns zoompan [+ зум/затирка/зеркало/eq
//   «Кадры из этого видео»]) -> concat [-> vstack split] -> mux с голосом(volume)/музыкой (-shortest)
//   -> ass=reel_subs.ass -> drawtext-заголовок -> _fit_to_target (setpts/atempo + жёсткая обрезка)
//   -> + финальный кадр (fade-in 0.5с) -> _brand (логотип + белое свечение) -> mp4.
import { loadFonts, cssFont } from './fonts.js';
import { AssRenderer } from './ass_render.js';
import { drawFit } from './frames.js';
import * as A from './audio.js';

let MB = null;
async function mb() { if (!MB) MB = await import('./lib/mediabunny.min.mjs'); return MB; }
export const FPS = 30;

// --- источник кадров клипа ---
async function openClip(c) {
  if (c.kind === 'video') {
    const M = await mb();
    const input = new M.Input({ source: new M.BlobSource(c.blob), formats: M.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('нет видеопотока');
    const dur = await vt.computeDuration();
    return { kind: 'video', input, vt, dur: Math.max(0.05, dur), sink: new M.VideoSampleSink(vt) };
  }
  if (c.kind === 'image') { const bmp = await createImageBitmap(c.blob); return { kind: 'image', bmp }; }
  return { kind: 'color' };
}
function drawCover(ctx, src, sw, sh, W, H) {
  const sc = Math.max(W / sw, H / sh); const dw = sw * sc, dh = sh * sc;
  if (src.draw) src.draw(ctx, (W - dw) / 2, (H - dh) / 2, dw, dh); else ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}
// Ken Burns как zoompan: z=min(zoom+0.0012,1.12), 4 варианта пана по номеру сцены
function drawKenBurns(ctx, bmp, n, d, variant, W, H) {
  const z = Math.min(1 + 0.0012 * (n + 1), 1.12);
  const iw = W, ih = H; const cw = iw / z, ch = ih / z;
  let x = iw / 2 - cw / 2, y = ih / 2 - ch / 2;
  if (variant === 1) x = (iw - cw) * n / d;
  else if (variant === 2) x = (iw - cw) * (1 - n / d);
  else if (variant === 3) y = (ih - ch) * n / d;
  const sc = Math.max(W / bmp.width, H / bmp.height); const ox = (bmp.width * sc - W) / 2, oy = (bmp.height * sc - H) / 2;
  ctx.drawImage(bmp, (x + ox) / sc, (y + oy) / sc, cw / sc, ch / sc, 0, 0, W, H);
}

// Заголовок (drawtext T1..T10) — тот же набор тем, что _burn_title
export function drawTitle(ctx, t, W, H) {
  if (!t || !t.text) return;
  const fs = Math.max(28, Math.trunc(H * t.fontpct)); const f = cssFont('Arial Black', fs);
  ctx.save(); ctx.font = f; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  const cap = t.text.toUpperCase();
  const lines = cap.split('\n').filter(l => l.trim());
  let l1, l2;
  if (lines.length >= 2) { l1 = lines[0]; l2 = lines[1]; }
  else { const one = lines[0] || cap; const wl = one.split(/\s+/).filter(Boolean); if (wl.length > 1) { const mid = Math.floor((wl.length + 1) / 2); l1 = wl.slice(0, mid).join(' '); l2 = wl.slice(mid).join(' '); } else { l1 = one; l2 = ''; } }
  const xp = t.xpct, yp = t.split ? 0.5 : t.ypct;
  const block = (txt) => { const ls = txt.split('\n'); const w = Math.max(...ls.map(s => ctx.measureText(s).width)); const h = ls.length * fs + (ls.length - 1) * 10; return { ls, w, h }; };
  const dt = (txt, color, xexpr, yexpr, box, extra) => {
    const b = block(txt); const x = xexpr(b.w), y = yexpr(b.h);
    if (box) { ctx.fillStyle = box; ctx.fillRect(x - 22, y - 22, b.w + 44, b.h + 44); }
    b.ls.forEach((s, i) => {
      const yy = y + i * (fs + 10); const xx = x;
      if (extra && extra.shadow) { ctx.fillStyle = extra.shadow; ctx.fillText(s, xx + extra.sx, yy + extra.sy); }
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.strokeText(s, xx, yy);
      ctx.fillStyle = color; ctx.fillText(s, xx, yy);
    });
  };
  const X = (w) => W * xp - w / 2, Y = (h) => H * yp - h / 2;
  const theme = t.theme;
  if (theme === 'T2') dt(cap, '#fff', X, Y, '#C8102E');
  else if (theme === 'T4') dt(cap, '#fff', X, Y, 'rgba(0,0,0,0.9)', { shadow: '#FFD600', sx: 0, sy: 8 });
  else if (theme === 'T5') { if (l2) { dt(l1, '#fff', X, (h) => H * yp - h - 4, 'rgba(0,0,0,0.9)'); dt(l2, '#000', X, () => H * yp + 4, '#FFD600'); } else dt(l1, '#000', X, Y, '#FFD600'); }
  else if (theme === 'T7') { if (l2) { dt(l1, '#fff', X, (h) => H * yp - h - 4); dt(l2, '#FF2D2D', X, () => H * yp + 4); } else dt(l1, '#FF2D2D', X, Y); }
  else if (theme === 'T8') dt(cap, '#000', X, Y, '#FFD600');
  else if (theme === 'T10') dt(cap, '#FF8C00', X, Y, null, { shadow: '#B22222', sx: 3, sy: 3 });
  else dt(cap, '#fff', X, Y, 'rgba(0,0,0,0.9)');
  ctx.restore();
}

// _brand: логотип (scale lw:-1, colorchannelmixer aa) + белое свечение (lutrgb 255, boxblur 8, aa .6)
export async function makeLogo(logoBlob, vw, vh, sizePct, xpct, ypct, opacityPct) {
  const bmp = await createImageBitmap(logoBlob);
  const lw = Math.max(40, Math.trunc(vw * sizePct / 100)); const lh = Math.max(1, Math.round(bmp.height * lw / bmp.width));
  const aa = Math.max(0, Math.min(1, opacityPct / 100));
  const pad = 24;
  const glow = new OffscreenCanvas(lw + pad * 2, lh + pad * 2); const g = glow.getContext('2d');
  g.drawImage(bmp, pad, pad, lw, lh); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#fff'; g.fillRect(0, 0, glow.width, glow.height);
  const glowB = new OffscreenCanvas(glow.width, glow.height); const gb = glowB.getContext('2d'); gb.filter = 'blur(6px)'; gb.drawImage(glow, 0, 0);
  const x = Math.round((vw - lw) * xpct), y = Math.round((vh - lh) * ypct);
  return { bmp, glow: glowB, pad, x, y, w: lw, h: lh, aa };
}
function drawLogo(ctx, L) {
  if (!L) return;
  ctx.save();
  ctx.globalAlpha = L.aa * 0.60; ctx.drawImage(L.glow, L.x - L.pad, L.y - L.pad);
  ctx.globalAlpha = L.aa; ctx.drawImage(L.bmp, L.x, L.y, L.w, L.h);
  ctx.restore();
}

// пост-обработка кадра «Кадры из этого видео»: затирка зоны -> hflip -> eq (как _foreign_uniq_vf)
let _tmpC = null;
function applyPost(ctx, post, W, H) {
  if (!post) return;
  if (post.zone) { const z = post.zone; ctx.fillStyle = z.color; ctx.fillRect(z.x, z.y, z.w, z.h); }
  if (post.mirror || post.eq) {
    if (!_tmpC || _tmpC.width !== W || _tmpC.height !== H) _tmpC = new OffscreenCanvas(W, H);
    const t = _tmpC.getContext('2d'); t.clearRect(0, 0, W, H); t.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    if (post.eq) ctx.filter = `brightness(${(1 + post.eq.b).toFixed(3)}) contrast(${post.eq.c.toFixed(3)}) saturate(${post.eq.s.toFixed(3)})`;
    if (post.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(_tmpC, 0, 0); ctx.restore();
  }
}

/**
 * spec: { W,H, clips:[{kind:'video'|'image'|'color', blob, frames, start, end, kb, color, fit:{blur,zoom}, post}],
 *         voice: AudioBuffer, voiceGain?, music?: {buf, db}, ass?: string, title?: {...}, logo?: makeLogo(),
 *         split?: {top:{kind,blob}, order:'video_top'|'video_bottom'},
 *         fit: {r, trimTo|null}, outro?: {makeCanvas(lastFrame)|canvas, dur, audio: AudioBuffer}, onProgress(frac) }
 * -> { blob, duration, lastFrame }
 */
export async function renderReel(spec) {
  const M = await mb(); await loadFonts();
  const W = spec.W || 1080, H = spec.H || 1920;
  const sr = 44100;
  // ---------- 1) звук контента: голос (volume «Своя сборка») + музыка (-stream_loop, volume, afade) ----------
  let voice = await A.resample(spec.voice, sr, 2);
  const vg = spec.voiceGain ?? 1;
  if (Math.abs(vg - 1) > 0.001) { for (let ch = 0; ch < voice.numberOfChannels; ch++) { const d = voice.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= vg; } }
  const vlen = voice.duration;
  let content = voice;
  if (spec.music && spec.music.buf) {
    const oc = new OfflineAudioContext(2, voice.length, sr);
    const v = oc.createBufferSource(); v.buffer = voice; v.connect(oc.destination); v.start();
    const m = oc.createBufferSource(); m.buffer = spec.music.buf; m.loop = true;
    const g = oc.createGain(); const gv = A.dbToGain(spec.music.db); const fst = Math.max(0, vlen - 2.0);
    g.gain.setValueAtTime(gv, 0); g.gain.setValueAtTime(gv, fst); g.gain.linearRampToValueAtTime(0, fst + 2.0);
    m.connect(g); g.connect(oc.destination); m.start();
    content = await oc.startRendering();
  }
  // -shortest: длина = min(видеоряд, звук)
  const videoFrames = spec.clips.reduce((a, c) => a + c.frames, 0);
  let L = Math.min(videoFrames / FPS, content.duration);
  // ---------- 2) подгонка длины (setpts/atempo + жёсткая обрезка) ----------
  const r = (spec.fit && spec.fit.r > 1.001) ? spec.fit.r : 1.0;
  let contentAudio = A.slice(content, 0, L);
  if (r !== 1.0) contentAudio = A.atempo(contentAudio, r);
  let outLen = L / r;
  if (spec.fit && spec.fit.trimTo && outLen > spec.fit.trimTo) { outLen = spec.fit.trimTo; }
  contentAudio = A.slice(contentAudio, 0, outLen);
  // ---------- 3) кодеры ----------
  const vcodec = (await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H })) || 'avc';
  const acodec = (await M.getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac';
  try { (await import('./core.js')).log(`  🎞 кодек: видео ${vcodec}, звук ${acodec} (${vcodec === 'avc' ? 'mp4' : 'webm'})`); } catch (e) { }
  const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d', { alpha: false });
  const output = new M.Output({ format: vcodec === 'avc' ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(), target: new M.BufferTarget() });
  const vsrc = new M.CanvasSource(canvas, { codec: vcodec, bitrate: 8e6, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  const asrc = new M.AudioBufferSource({ codec: acodec, bitrate: 192e3 });
  output.addAudioTrack(asrc);
  output.setMetadataTags && output.setMetadataTags({ title: spec.metaTitle || '', comment: spec.metaTitle || '', date: new Date() });
  await output.start();
  const ass = spec.ass ? new AssRenderer(spec.ass) : null;
  const outFramesContent = Math.max(1, Math.round(outLen * FPS));
  const outroFrames = spec.outro ? Math.round(spec.outro.dur * FPS) : 0;
  const totalFrames = outFramesContent + outroFrames;
  const prog = (k) => spec.onProgress && spec.onProgress(k / totalFrames);
  // ---------- split: верхняя/нижняя половина 1080×960 ----------
  const split = spec.split || null;
  const RH = split ? Math.trunc(H / 2) : H;                         // высота области клипов сцен
  const RY = split ? (split.order === 'video_bottom' ? 0 : RH) : 0;  // сцены снизу при video_top
  let top = null;
  if (split && split.top) {
    try {
      const ts = await openClip(split.top);
      if (ts.kind === 'video') {
        const gen = function* () { for (let k = 0; k < outFramesContent; k++) { let t = (k / FPS) * r; if (t >= ts.dur) t = t % ts.dur; yield t; } };
        top = { kind: 'video', src: ts, it: ts.sink.samplesAtTimestamps(gen())[Symbol.asyncIterator]() };
      } else if (ts.kind === 'image') top = { kind: 'image', bmp: ts.bmp };
    } catch (e) { top = null; }
  }
  const TY = split ? (RY === 0 ? RH : 0) : 0;
  async function drawTop() {
    if (!split) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, TY, W, H - RH); ctx.clip(); ctx.translate(0, TY);
    ctx.fillStyle = '#1a1230'; ctx.fillRect(0, 0, W, H - RH);
    if (top && top.kind === 'video') { try { const nx = await top.it.next(); const s = nx.value; if (s) { drawCover(ctx, s, s.displayWidth, s.displayHeight, W, H - RH); s.close(); } } catch (e) { } }
    else if (top && top.kind === 'image') drawCover(ctx, top.bmp, top.bmp.width, top.bmp.height, W, H - RH);
    ctx.restore();
  }
  function region(fn) { ctx.save(); if (split) { ctx.beginPath(); ctx.rect(0, RY, W, RH); ctx.clip(); ctx.translate(0, RY); } fn(); ctx.restore(); }
  // ---------- 4) кадры контента ----------
  const starts = []; { let a = 0; for (const c of spec.clips) { starts.push(a); a += c.frames; } }
  let k = 0;
  for (let ci = 0; ci < spec.clips.length && k < outFramesContent; ci++) {
    const c = spec.clips[ci]; const f0 = starts[ci], f1 = f0 + c.frames;
    const ks = []; for (let kk = k; kk < outFramesContent; kk++) { const fc = Math.floor((kk / FPS) * r * FPS + 1e-6); if (fc >= f1) break; if (fc >= f0) ks.push([kk, fc - f0]); else continue; }
    if (!ks.length) continue;
    let src = null;
    try { src = await openClip(c); } catch (e) { src = { kind: 'color' }; c.color = c.color || '#1a1230'; }
    if (src.kind === 'video') {
      const st = c.start || 0; const segLen = (c.end && c.end > st + 0.1) ? (c.end - st) : 0;
      const ts = ks.map(([, n]) => { let t; if (segLen) t = st + ((n / FPS) % segLen); else { t = st + n / FPS; if (t >= src.dur) t = t % src.dur; } return Math.min(t, Math.max(0, src.dur - 0.01)); });
      let j = 0;
      try {
        for await (const s of src.sink.samplesAtTimestamps(ts)) {
          const [kk, n] = ks[j++];
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          if (s) { region(() => { if (c.fit) drawFit(ctx, s, s.displayWidth, s.displayHeight, W, RH, c.fit); else drawCover(ctx, s, s.displayWidth, s.displayHeight, W, RH); }); s.close(); }
          applyPost(ctx, c.post, W, H);
          await overlayAndAdd(kk, n);
        }
      } catch (e) {
        for (; j < ks.length; j++) { const [kk, n] = ks[j]; ctx.fillStyle = '#1a1230'; ctx.fillRect(0, 0, W, H); await overlayAndAdd(kk, n); }
      }
      try { src.input.dispose && src.input.dispose(); } catch (e) { }
    } else {
      for (const [kk, n] of ks) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        if (src.kind === 'image') region(() => drawKenBurns(ctx, src.bmp, n, Math.max(1, c.frames), (c.kb || 0) % 4, W, RH));
        else region(() => { ctx.fillStyle = c.color || '#141018'; ctx.fillRect(0, 0, W, RH); });
        await overlayAndAdd(kk, n);
      }
      if (src.bmp) src.bmp.close();
    }
    k = ks[ks.length - 1][0] + 1;
  }
  for (; k < outFramesContent; k++) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); await overlayAndAdd(k, 0); }
  const lastFrame = await createImageBitmap(canvas);
  async function overlayAndAdd(kk) {
    await drawTop();
    const tc = (kk / FPS) * r;
    if (spec.overlay) spec.overlay(ctx, tc, W, H);         // напр. заголовок нарезки (_burn_caption)
    if (ass) ass.draw(ctx, tc);
    if (spec.title) drawTitle(ctx, spec.title, W, H);
    drawLogo(ctx, spec.logo);
    await vsrc.add(kk / FPS, 1 / FPS);
    if (kk % 15 === 0) prog(kk);
  }
  // ---------- 5) финальный кадр (fade-in 0.5с из чёрного), логотип поверх (как _brand по итогу) ----------
  let outroAudio = null;
  if (spec.outro) {
    const oc = spec.outro.makeCanvas ? await spec.outro.makeCanvas(lastFrame) : spec.outro.canvas;
    for (let n = 0; n < outroFrames; n++) {
      const t = n / FPS; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = Math.min(1, t / 0.5); ctx.drawImage(oc, 0, 0, W, H); ctx.globalAlpha = 1;
      drawLogo(ctx, spec.logo);
      await vsrc.add((outFramesContent + n) / FPS, 1 / FPS);
      if (n % 15 === 0) prog(outFramesContent + n);
    }
    outroAudio = spec.outro.audio ? A.slice(await A.resample(spec.outro.audio, sr, 2), 0, outroFrames / FPS) : A.silence(outroFrames / FPS, sr, 2);
    if (outroAudio.duration < outroFrames / FPS - 0.01) outroAudio = A.concat([outroAudio, A.silence(outroFrames / FPS - outroAudio.duration, sr, 2)], sr, 2);
  }
  vsrc.close();
  // ---------- 6) звук: контент (точно по длине видео контента) + финал ----------
  let aContent = contentAudio;
  const needC = outFramesContent / FPS;
  if (aContent.duration < needC - 0.005) aContent = A.concat([aContent, A.silence(needC - aContent.duration, sr, 2)], sr, 2);
  else aContent = A.slice(aContent, 0, needC);
  const fullAudio = outroAudio ? A.concat([aContent, outroAudio], sr, 2) : aContent;
  await asrc.add(fullAudio); asrc.close();
  await output.finalize();
  try { if (top && top.src && top.src.input) top.src.input.dispose && top.src.input.dispose(); } catch (e) { }
  const type = vcodec === 'avc' ? 'video/mp4' : 'video/webm';
  return { blob: new Blob([output.target.buffer], { type }), duration: totalFrames / FPS, contentDuration: needC, lastFrame, ext: vcodec === 'avc' ? '.mp4' : '.webm' };
}

// отрезок исходника [at, at+len] в 9:16 без звука (scene_play «Кадры из этого видео»)
export async function renderSegment(blob, at, len, fit) {
  const frames = Math.max(1, Math.round(len * FPS));
  const res = await renderReel({ W: 1080, H: 1920, clips: [{ kind: 'video', blob, frames, start: at, fit }], voice: A.silence(len, 44100, 2), fit: { r: 1, trimTo: null } });
  return res.blob;
}

// Звук финального кадра (_make_outro_audio): озвучка призыва + музыка (-1.5с fade), длина dur
export async function outroAudio(dur, voiceBuf, musicBuf, music_db) {
  const sr = 44100; const oc = new OfflineAudioContext(2, Math.max(1, Math.round(dur * sr)), sr);
  if (voiceBuf) { const v = oc.createBufferSource(); v.buffer = voiceBuf; v.connect(oc.destination); v.start(); }
  if (musicBuf) {
    const m = oc.createBufferSource(); m.buffer = musicBuf; m.loop = true; const g = oc.createGain(); const gv = A.dbToGain(music_db); const fst = Math.max(0, dur - 1.5);
    g.gain.setValueAtTime(gv, 0); g.gain.setValueAtTime(gv, fst); g.gain.linearRampToValueAtTime(0, fst + 1.5); m.connect(g); g.connect(oc.destination); m.start();
  }
  return await oc.startRendering();
}

// готовый ролик на другой скорости: video setpts=PTS/N + audio atempo=N (тот же путь, что fit.r)
export async function retime(blob, mult) {
  const M = await mb();
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack(); const dur = await vt.computeDuration();
  const W = vt.displayWidth || 1080, H = vt.displayHeight || 1920;
  try { input.dispose && input.dispose(); } catch (e) { }
  const voice = await A.decode(blob);
  const res = await renderReel({ W, H, clips: [{ kind: 'video', blob, frames: Math.max(1, Math.round(dur * FPS)) }], voice, fit: { r: mult, trimTo: null } });
  return res.blob;
}
