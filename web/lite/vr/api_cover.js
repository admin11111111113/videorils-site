// Порт Api (Лайт): ОБЛОЖКА-ХУК — отдельный PNG 1080×1920 (фон из стока без лиц / градиент /
// сплит + короткий цепляющий заголовок по одному из 6 шаблонов). Рандомизация по осям COVER_*.
// PIL ImageDraw -> canvas: те же шаблоны, размеры, обводка, тень, наклон.
import { C, log, vfs, path, now, blobToDataUrl, choice } from './core.js';
import { loadFonts, cssFont } from './fonts.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const W = 1080, H = 1920;
const hexRgb = (h) => { h = String(h || '#FFFFFF').replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

P._cover_axes_pick = function () {
  const [name, ffile] = choice(C.COVER_FONTS); const [acc, acc2] = choice(C.COVER_ACCENT_PAIRS);
  return { accent: acc, accent2: acc2, font_name: name, font_file: ffile, wrap: choice(C.COVER_WRAPS), layout: choice(C.COVER_LAYOUTS),
    template: choice(C.COVER_TEMPLATES), bg_style: choice(C.COVER_BG_STYLES), tilt: choice(C.COVER_TILTS), scheme: choice(C.COVER_SCHEMES) };
};
// 1 фото/кадр из стока по теме + модификатор (широкий / крупный план), без лиц; свой used-set
P._cover_fetch = async function (kind, seed) {
  let topic = (this.reel_topic || '').trim();
  if (!topic) topic = (this._cover_theme || '').trim().split(/\s+/).slice(0, 5).join(' ');
  if (!topic) return null;
  const wide = ['wide cinematic landscape', 'aerial city view', 'scenic panorama', 'wide establishing shot', 'vast scenery', 'empty interior wide'];
  const close = ['close up detail', 'macro object', 'product still life', 'single object studio', 'detail texture', 'object on table'];
  const mods = kind === 'wide' ? wide : close;
  const q = `${topic} ${mods[seed % mods.length]}`;
  if (!(this._cover_bg_used instanceof Set)) this._cover_bg_used = new Set();
  const _prev = this._reel_used_clips; this._reel_used_clips = this._cover_bg_used;
  let src = null, isv = null;
  try { [src, isv] = await this._download_pixabay(q, `cov_${kind}_${seed}`); } catch (e) { src = null; } finally { this._reel_used_clips = _prev; }
  if (!(src && vfs.exists(src))) return null;
  if (isv) {
    const frame = `temp/cov_${kind}_${seed}.jpg`;
    try { const { frameAt } = await import('./frames.js'); await frameAt(src, 0.6, frame, { W, H, quality: 0.92 }); } catch (e) { return null; }
    return vfs.exists(frame) ? frame : null;
  }
  return src;
};
P.set_cover_theme = function (story) { this._cover_theme = String(story || '').trim().slice(0, 400); return { ok: true }; };
// обложка в фоне ПАРАЛЛЕЛЬНО с генерацией сцен (по теме); фронт опрашивает poll_cover_async
P.begin_cover_async = function (story) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  this._cover_theme = String(story || '').trim().slice(0, 400);
  this._cover_async = { state: 'run', dataurl: '', err: '', meta: {} };
  if (!this._cover_theme) { this._cover_async = { state: 'err', dataurl: '', err: this._t('cover_no_theme'), meta: {} }; return { ok: false }; }
  (async () => {
    try {
      const en = this.video_lang === 'en';
      const r = await this.regen_hook_cover('all', !en);
      if (r && r.ok) this._cover_async = { state: 'done', dataurl: r.dataurl || '', err: '', meta: { template: r.template || '', accent: r.accent || '', font: r.font || '', secs: r.secs } };
      else this._cover_async = { state: 'err', dataurl: '', err: (r || {}).err || 'не собралось', meta: {} };
    } catch (e) { this._cover_async = { state: 'err', dataurl: '', err: String(e.message || e), meta: {} }; }
  })();
  return { ok: true };
};
P.poll_cover_async = function () { return this._cover_async || { state: 'none' }; };
P._cover_source_hook = function () {
  const theme = (this._cover_theme || '').trim(); if (theme) return [theme, null];
  const phrases = this.reel_phrases || [];
  if (phrases.length && (phrases[0] || '').trim()) return [phrases[0].trim(), this.reel_highlights ? (this.reel_highlights[1] || null) : null];
  const scenes = this.reel_scenes || [];
  if (scenes.length && (scenes[0].text || '').trim()) { const kw = (scenes[0].kw || '').trim(); return [scenes[0].text.trim(), kw ? new Set(kw.split(/\s+/)) : null]; }
  return ['', null];
};
// без ИИ: 2 смысловые части через « / » (числительное не отрываем от существительного)
Api._cover_group_fallback = function (ws) {
  if (ws.length <= 2) return ws.join(' ');
  const NUM = new Set('один одна одно два две три четыре пять шесть семь восемь девять десять сто тысяча'.split(' '));
  const is_num = (w) => { w = w.toLowerCase().replace(/%/g, ''); return /^\d+$/.test(w) || NUM.has(w); };
  let mid = Math.floor(ws.length / 2);
  while (mid > 0 && mid < ws.length && is_num(ws[mid - 1])) mid++;
  if (mid <= 0 || mid >= ws.length) mid = Math.max(1, ws.length - 1);
  return ws.slice(0, mid).join(' ') + ' / ' + ws.slice(mid).join(' ');
};
const stripP = (w) => w.replace(/^[.,!?:;]+|[.,!?:;]+$/g, '');
P._cover_short_variants = async function (hook, n = 4, allow_ai = true) {
  hook = String(hook || '').trim(); if (!hook) return [];
  let topic = '';
  if (this.reel_scenes && this.reel_scenes.length) topic = this.reel_scenes.slice(0, 3).map(s => s.text || '').join(' ');
  else if (this.reel_phrases && this.reel_phrases.length) topic = this.reel_phrases.slice(0, 3).join(' ');
  topic = (topic || hook).trim();
  let variants = [];
  if (allow_ai && (this.claude_key || this.gemini_key)) {
    try {
      const lang = this.video_lang === 'en' ? 'английском' : 'русском';
      const prompt = `Тема/начало рилса: ${topic.slice(0, 400)}\nТекущий хук: ${hook.slice(0, 160)}\n\nПридумай ${n} РАЗНЫХ дерзких заголовка для ОБЛОЖКИ видео на ${lang} языке.\nГЛАВНОЕ правило — «ИНФОРМАЦИОННЫЙ РАЗРЫВ»: заголовок должен ВЫЗЫВАТЬ ЛЮБОПЫТСТВО, а НЕ объяснять суть. НЕ раскрывай ответ и НЕ перечисляй советы — только намекни на интригу, чтобы захотелось нажать и узнать.\nПриёмы (бери РАЗНЫЕ углы): одна ошибка/причина («ОШИБКА, из-за которой теряешь всё»); скрытое/запретное («ТО, ЧТО от тебя скрывают»); провокация, спор с очевидным («ПОЧЕМУ X — это ложь», «X больше НЕ работает»); ставка/последствие («это УБИВАЕТ твой …»); чистое любопытство («НИКТО не говорит про…», «сделай ЭТО до того, как…»).\nИЗБЕГАЙ описательных и «закрытых» формулировок, которые всё объясняют: НЕ «5 советов по X», НЕ «как сделать X», НЕ пересказ темы.\nХорошо: «ОДНА ОШИБКА / УБИВАЕТ ОХВАТ», «ПОЧЕМУ ТЫ / ВСЁ ЕЩЁ БЕДНЫЙ», «ТО, ЧТО / ОТ ТЕБЯ СКРЫВАЮТ». Плохо: «5 СОВЕТОВ / ПО ЗАРАБОТКУ», «КАК / ПОХУДЕТЬ», «ПРИВЫЧКИ / УСПЕШНЫХ ЛЮДЕЙ».\nКаждый — 3-6 слов, СТРОГО по этой теме, разные по углу. Разбей каждый на 2-3 смысловые части символом « / » (число НЕ отрывай от существительного). Верни РОВНО ${n} строк, по одному заголовку в строке, без нумерации/кавычек/пояснений.`;
      const [ok, out] = await this._ai_call(prompt, null, 220);
      if (ok && out) {
        for (const ln of Api._clean_ai_text(out).split('\n')) {
          const c = ln.trim().replace(/^[ \-—"'«»0-9.]+|[ \-—"'«»0-9.]+$/g, '').replace(/[.,;:!?…"»«]+$/, '').trim();
          const wc = c.replace(/\//g, ' ').split(/\s+/).filter(Boolean).length;
          if (c && wc >= 1 && wc <= 8 && c.length <= 72 && !variants.map(v => v.toUpperCase()).includes(c.toUpperCase())) variants.push(c);
        }
      }
    } catch (e) { variants = []; }
  }
  if (!variants.length) {
    const seg = hook.split(/[,.;:!?—–…]/)[0].trim();
    let allw = seg.split(/\s+/).filter(Boolean); if (!allw.length) allw = hook.split(/\s+/).filter(Boolean);
    const FILLER = new Set(['как', 'почему', 'что', 'чтобы', 'зачем', 'где', 'когда', 'чем', 'обрести', 'сделать', 'получить', 'добиться', 'найти', 'узнать', 'стать', 'начать', 'и', 'а', 'но']);
    while (allw.length > 3 && FILLER.has(stripP(allw[0].toLowerCase()))) allw = allw.slice(1);
    let ws = allw.slice(0, 6);
    const TAIL = new Set(['за', 'на', 'в', 'и', 'с', 'до', 'от', 'по', 'к', 'у', 'о']);
    while (ws.length > 3 && (/^\d+$/.test(stripP(ws[ws.length - 1])) || TAIL.has(stripP(ws[ws.length - 1].toLowerCase())))) ws = ws.slice(0, -1);
    variants = [Api._cover_group_fallback(ws)];
  }
  return variants.slice(0, n);
};
P._cover_short_text = async function (hook, advance = false, allow_ai = true) {
  hook = String(hook || '').trim(); if (!hook) return '';
  let pool = this._cover_text_pool; const pool_fb = !!this._cover_text_pool_fb; const cur_lang = this.video_lang;
  const need_new = !pool || !pool.length || this._cover_text_hook !== hook || this._cover_text_lang !== cur_lang || (pool_fb && allow_ai);
  if (need_new) {
    pool = await this._cover_short_variants(hook, 4, allow_ai);
    this._cover_text_pool = pool; this._cover_text_hook = hook; this._cover_text_lang = cur_lang; this._cover_text_i = 0; this._cover_text_pool_fb = !allow_ai;
  } else if (advance) {
    this._cover_text_i = (this._cover_text_i || 0) + 1;
    if (this._cover_text_i >= pool.length) {
      for (const m of await this._cover_short_variants(hook, 4, allow_ai)) if (!pool.map(p => p.toUpperCase()).includes(m.toUpperCase())) pool.push(m);
      this._cover_text_pool = pool;
      if (this._cover_text_i >= pool.length) this._cover_text_i = 0;
    }
  }
  return pool[(this._cover_text_i || 0) % Math.max(1, pool.length)];
};

// --- рисование заголовка (6 шаблонов), PIL-семантика: текст от верхней линии асцендера ---
function renderText(ctx, groups, keyl, fontName, acc, acc2, template, scheme, en) {
  const WHITE = [255, 255, 255], BLACK = [12, 12, 14];
  const maxw = Math.trunc(W * 0.92);
  const F = (sz) => { const s = Math.max(20, Math.trunc(sz)); ctx.font = cssFont(fontName, s); return s; };
  const met = (s) => ctx.measureText(s);
  const asc = () => met('ЙЁHg').fontBoundingBoxAscent; const lh = () => { const m = met('ЙЁHg'); return m.fontBoundingBoxAscent + m.fontBoundingBoxDescent; };
  const wln = (s) => met(s).width;
  const strk = (sz) => Math.max(4, Math.trunc(sz * 0.07));
  const fit = (s, hi, lo = 34, mw = null) => { mw = mw || maxw; let sz = hi; F(sz); while (sz > lo && wln(s) > mw) { sz -= 4; F(sz); } return sz; };
  const text = (s, x, y, fill, stroke = 0) => {
    ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; const by = y + asc();
    if (stroke) { ctx.strokeStyle = css(BLACK); ctx.lineWidth = stroke * 2; ctx.strokeText(s, x, by); }
    ctx.fillStyle = css(fill); ctx.fillText(s, x, by);
  };
  const dc = (s, y, fill, stroke = 0) => { const x = (W - wln(s)) / 2; text(s, x, y, fill, stroke); return lh(); };
  const dcf = (s, hi, y, fill, lo = 34) => { const sz = fit(s, hi, lo); return dc(s, y, fill, strk(sz)); };
  const dcg = (s, hi, y, c1, c2, lo = 34) => {
    const sz = fit(s, hi, lo); const st = strk(sz); const ww = Math.max(1, Math.trunc(wln(s))); const hh = lh(); const pad = st + 6;
    const tile = new OffscreenCanvas(ww + 2 * pad, hh + 2 * pad); const t = tile.getContext('2d'); t.font = ctx.font; t.textBaseline = 'alphabetic'; t.lineJoin = 'round';
    const by = pad + asc();
    t.strokeStyle = '#000'; t.lineWidth = st * 2; t.strokeText(s, pad, by);
    const g = t.createLinearGradient(0, 0, 0, tile.height); g.addColorStop(0, css(c1)); g.addColorStop(1, css(c2));
    t.fillStyle = g; t.fillText(s, pad, by);
    ctx.drawImage(tile, Math.trunc((W - tile.width) / 2), Math.trunc(y - pad));
    return hh;
  };
  const accent_line = (s, hi, y) => scheme === 'grad' ? dcg(s, hi, y, acc, acc2) : dcf(s, hi, y, acc);
  const col2 = () => scheme === 'two' ? acc2 : WHITE;
  const gj = (g) => g.join(' ');
  const flat = groups.flat();
  const _norm = (w) => w.toLowerCase().replace(/^[.,!?:;»«"()]+|[.,!?:;»«"()]+$/g, '');
  let keyidx = new Set(flat.map((w, i) => keyl.has(_norm(w)) ? i : -1).filter(i => i >= 0));
  if (!keyidx.size && flat.length) { let bi = 0; flat.forEach((w, i) => { if (_norm(w).length > _norm(flat[bi]).length) bi = i; }); keyidx = new Set([bi]); }
  const y0 = Math.trunc(H * 0.09), G = Math.trunc(H * 0.012);
  const bbox = (x, y, w) => { const m = met(w); const by = y + asc(); return [x - m.actualBoundingBoxLeft, by - m.actualBoundingBoxAscent, x + m.actualBoundingBoxRight, by + m.actualBoundingBoxDescent]; };
  if (template === 'floors') {
    let top, mid, bot;
    if (groups.length >= 3) { top = gj(groups[0]); mid = gj(groups[1]); bot = groups.slice(2).flat().join(' '); }
    else if (groups.length === 2) { top = gj(groups[0]); mid = gj(groups[1]); bot = ''; }
    else { const ws = groups[0]; if (ws.length >= 3) { top = ws[0]; mid = ws.slice(1, -1).join(' '); bot = ws[ws.length - 1]; } else { top = ''; mid = gj(ws); bot = ''; } }
    let y = y0;
    if (top) y += dcf(top, Math.trunc(H * 0.052), y, col2()) + G;
    y += accent_line(mid, Math.trunc(H * 0.155), y) + G;
    if (bot) dcf(bot, Math.trunc(H * 0.052), y, WHITE);
  } else if (template === 'punch') {
    let topline, bottom;
    if (groups.length >= 2) { topline = groups.slice(0, -1).flat().join(' '); bottom = gj(groups[groups.length - 1]); }
    else { const ws = groups[0]; topline = ws.slice(0, -1).join(' ') || gj(ws); bottom = ws[ws.length - 1]; }
    let y = y0; y += dcf(topline, Math.trunc(H * 0.062), y, col2()) + Math.trunc(H * 0.02);
    accent_line(bottom, Math.trunc(H * 0.155), y);
  } else if (template === 'split') {
    const conn = choice(en ? ['finally', 'but', 'or', 'and', 'yet', 'so'] : ['наконец', 'но', 'или', 'а', 'зато', 'вот']);
    let top, bottom;
    if (groups.length >= 2) { top = gj(groups[0]); bottom = groups.slice(1).flat().join(' '); }
    else { const ws = groups[0]; const h = Math.max(1, Math.floor(ws.length / 2)); top = ws.slice(0, h).join(' '); bottom = ws.slice(h).join(' ') || top; }
    let y = y0; y += dcf(top, Math.trunc(H * 0.09), y, col2()) + G;
    y += dcf(conn, Math.trunc(H * 0.045), y, [235, 235, 235]) + G;
    accent_line(bottom, Math.trunc(H * 0.09), y);
  } else if (template === 'header') {
    let subj, rest;
    if (groups.length >= 2) { subj = gj(groups[0]); rest = groups.slice(1).filter(g => g.length).map(gj); }
    else { const ws = groups[0]; subj = ws[0] || ''; rest = ws.length > 1 ? [ws.slice(1).join(' ')] : []; }
    let y = y0; y += dcf(subj, Math.trunc(H * 0.155), y, col2()) + Math.trunc(H * 0.02);
    rest.forEach((l, i) => { if (i === rest.length - 1) y += accent_line(l, Math.trunc(H * 0.052), y) + G; else y += dcf(l, Math.trunc(H * 0.052), y, WHITE) + G; });
  } else {
    let rows = groups.every(g => g.length <= 3) ? groups : (() => { const r = []; for (let i = 0; i < flat.length; i += 3) r.push(flat.slice(i, i + 3)); return r; })();
    rows = rows.filter(r => r.length); if (!rows.length) rows = [['']];
    const longest = rows.reduce((a, b) => b.join(' ').length > a.join(' ').length ? b : a).join(' ');
    if (template === 'marker') {
      const sM = fit(longest, Math.trunc(H * 0.085)); const st = strk(sM); const sp = wln(' '); let gi = 0, y = y0;
      for (const row of rows) {
        const rw = row.reduce((a, w) => a + wln(w), 0) + sp * Math.max(0, row.length - 1); let x = (W - rw) / 2;
        for (const w of row) {
          if (keyidx.has(gi)) {
            const bb = bbox(x, y, w); const my = bb[3] - Math.trunc(sM * 0.08), hh = Math.trunc(sM * 0.26), pad = Math.trunc(sM * 0.12), tilt = Math.trunc(sM * 0.06);
            ctx.fillStyle = css(acc, 210 / 255); ctx.beginPath(); ctx.moveTo(bb[0] - pad, my + tilt); ctx.lineTo(bb[2] + pad, my - tilt); ctx.lineTo(bb[2] + pad, my - tilt + hh); ctx.lineTo(bb[0] - pad, my + tilt + hh); ctx.closePath(); ctx.fill();
          }
          text(w, x, y, WHITE, st); x += wln(w) + sp; gi++;
        }
        y += lh() + G;
      }
    } else {   // capsule
      const lum = 0.299 * acc[0] + 0.587 * acc[1] + 0.114 * acc[2]; const keytxt = lum > 140 ? BLACK : WHITE;
      const sC = fit(longest, Math.trunc(H * 0.092)); const st = strk(sC); const sp = wln(' '); let gi = 0, y = y0;
      for (const row of rows) {
        const rw = row.reduce((a, w) => a + wln(w) + 2 * st, 0) + sp * Math.max(0, row.length - 1); let x = (W - rw) / 2;
        for (const w of row) {
          if (keyidx.has(gi)) {
            const bb = bbox(x, y, w); const padx = Math.trunc(sC * 0.14), pady = Math.trunc(sC * 0.06);
            const r = [bb[0] - padx, bb[1] - pady, bb[2] + padx, bb[3] + pady]; const rad = Math.max(6, Math.trunc((r[3] - r[1]) * 0.30));
            ctx.fillStyle = css(acc); ctx.beginPath(); ctx.roundRect(r[0], r[1], r[2] - r[0], r[3] - r[1], rad); ctx.fill();
            text(w, x, y, keytxt, 0);
          } else text(w, x, y, WHITE, st);
          x += wln(w) + 2 * st + sp; gi++;
        }
        y += lh() + Math.trunc(H * 0.02);
      }
    }
  }
}
async function loadImg(p) { return await createImageBitmap(vfs.read(p)); }
function fitDraw(ctx, bmp, tw, th, filter = 'none') {
  const s = Math.max(tw / bmp.width, th / bmp.height); const dw = bmp.width * s, dh = bmp.height * s;
  ctx.save(); ctx.filter = filter; ctx.drawImage(bmp, (tw - dw) / 2, (th - dh) / 2, dw, dh); ctx.restore();
}
// СПЛИТ-ЭКРАН: две разные тематические фото — одна Ч/Б-приглушённая, другая насыщенная
P._cover_split_bg = async function (seed) {
  const pa = await this._cover_fetch('wide', seed), pb = await this._cover_fetch('wide', seed + 300);
  if (!(pa && pb)) return null;
  let a, b; try { a = await loadImg(pa); b = await loadImg(pb); } catch (e) { return null; }
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  fitDraw(x, b, W, H, 'saturate(1.25)');
  const diagonal = seed % 2 === 0;
  x.save(); x.beginPath(); if (diagonal) { x.moveTo(0, 0); x.lineTo(W, 0); x.lineTo(0, H); x.closePath(); } else x.rect(0, 0, W / 2, H); x.clip();
  fitDraw(x, a, W, H, 'grayscale(1) brightness(0.82)'); x.restore();
  x.strokeStyle = 'rgb(245,245,245)'; x.lineWidth = 6; x.beginPath();
  if (diagonal) { x.moveTo(W, 0); x.lineTo(0, H); } else { x.moveTo(W / 2, 0); x.lineTo(W / 2, H); } x.stroke();
  return c;
};
// ФОН обложки: градиент / сплит / одно широкое фото + затемнение сверху под текст
P._cover_compose_bg = async function (seed, params) {
  let base = null; const bstyle = params.bg_style;
  if (bstyle === 'color') {
    const deep = (h) => hexRgb(h).map(v => Math.trunc(v * 0.5));
    const c1 = deep(params.accent), c2 = deep(params.accent2 || params.accent);
    base = new OffscreenCanvas(W, H); const x = base.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, css(c1)); g.addColorStop(1, css(c2)); x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  if (!base && bstyle === 'split') { try { base = await this._cover_split_bg(seed); } catch (e) { base = null; } }
  if (!base) {
    base = new OffscreenCanvas(W, H); const x = base.getContext('2d');
    const wide = await this._cover_fetch('wide', seed); let bmp = null;
    try { bmp = wide ? await loadImg(wide) : null; } catch (e) { bmp = null; }
    if (!bmp) { x.fillStyle = 'rgb(28,18,52)'; x.fillRect(0, 0, W, H); }
    else { fitDraw(x, bmp, W, H, 'saturate(1.4) contrast(1.08)'); x.fillStyle = 'rgba(0,0,0,0.10)'; x.fillRect(0, 0, W, H); }
  }
  if (bstyle !== 'color') {
    const x = base.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, H * 0.46);
    g.addColorStop(0, 'rgba(0,0,0,' + (180 / 255).toFixed(3) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, W, Math.ceil(H * 0.46));
  }
  return base;
};
P._build_cover_png = async function (seed = null, params = null, mode = 'all', fast_text = false) {
  await loadFonts();
  const [hook, hook_keyset] = this._cover_source_hook(); if (!hook) return null;
  if (seed === null) seed = this._cover_seed || 0;
  if ((mode === 'text' || mode === 'bg') && this._cover_params) params = this._cover_params;
  else { params = params || this._cover_axes_pick(); this._cover_params = params; }
  let base;
  if (mode === 'text' && this._cover_bg_base) { base = new OffscreenCanvas(W, H); base.getContext('2d').drawImage(this._cover_bg_base, 0, 0); }
  else { base = await this._cover_compose_bg(seed, params); const cp = new OffscreenCanvas(W, H); cp.getContext('2d').drawImage(base, 0, 0); this._cover_bg_base = cp; }
  const fontName = params.font_name === 'Impact' ? 'Impact' : 'Arial Black';
  const keyl = new Set([...(hook_keyset || [])].map(k => String(k || '').toLowerCase().replace(/^[.,!?:;»«"()]+|[.,!?:;»«"()]+$/g, '')));
  const short = await this._cover_short_text(hook, mode === 'all' || mode === 'text', !fast_text);
  let groups = short.split('/').map(part => part.toUpperCase().split(/\s+/).filter(Boolean)).filter(g => g.length);
  if (!groups.length) groups = [[hook.toUpperCase().slice(0, 16)]];
  const acc = hexRgb(params.accent), acc2 = hexRgb(params.accent2 || params.accent);
  const txt = new OffscreenCanvas(W, H); const tctx = txt.getContext('2d');
  renderText(tctx, groups, keyl, fontName, acc, acc2, params.template || 'capsule', params.scheme || 'solid', this.video_lang === 'en');
  let layer = txt;
  const tilt = params.tilt || 0;
  if (tilt) { const r = new OffscreenCanvas(W, H); const rx = r.getContext('2d'); const cy = Math.trunc(H * 0.27); rx.translate(W / 2, cy); rx.rotate(-tilt * Math.PI / 180); rx.translate(-W / 2, -cy); rx.drawImage(txt, 0, 0); layer = r; }
  // тень: размытая альфа текста, чёрная 195, смещение (4,7)
  const sh = new OffscreenCanvas(W, H); const sx = sh.getContext('2d'); sx.filter = 'blur(8px)'; sx.drawImage(layer, 0, 0); sx.filter = 'none';
  sx.globalCompositeOperation = 'source-in'; sx.fillStyle = 'rgba(0,0,0,' + (195 / 255).toFixed(3) + ')'; sx.fillRect(0, 0, W, H);
  const bx = base.getContext('2d'); bx.drawImage(sh, 4, 7); bx.drawImage(layer, 0, 0);
  const out_png = 'temp/hook_cover.png';
  vfs.write(out_png, await base.convertToBlob({ type: 'image/png' })); await vfs.flush(out_png);
  this._cover_png_hook = hook;
  return out_png;
};
P.regen_hook_cover = async function (mode = 'all', fast_text = false) {
  mode = ['all', 'text', 'bg'].includes(mode) ? mode : 'all';
  const [hook] = this._cover_source_hook(); if (!hook) return { ok: false, err: this._t('cover_need_scenes') };
  if ((mode === 'text' || mode === 'bg') && !this._cover_params) mode = 'all';
  this._cover_seed = (this._cover_seed || 0) + 1;
  const t0 = now(); let png;
  try { png = await this._build_cover_png(this._cover_seed, null, mode, fast_text); } catch (e) { return { ok: false, err: String(e.message || e) }; }
  if (!(png && vfs.exists(png))) return { ok: false, err: this._t('cover_build_fail') };
  this._cover_png = png;
  let dataurl = ''; try { dataurl = await blobToDataUrl(vfs.read(png)); } catch (e) { }
  const p = this._cover_params || {};
  const tpl = ({ floors: 'этажи', punch: 'панч', split: 'сплит', marker: 'маркер', header: 'заголовок', capsule: 'капсула' })[p.template] || p.template || '';
  return { ok: true, path: png, seed: this._cover_seed, secs: Math.round((now() - t0) * 10) / 10, dataurl, accent: p.accent || '', font: p.font_name || '', template: tpl,
    layout: ({ bottom: 'нижняя полоса', corner: 'угол' })[p.layout] || p.layout || '' };
};
// «Взять картинку хука»: PNG обложки — скачать (имя = <ролик>_обложка.png)
P.export_hook_cover = function () {
  const png = this._cover_png || '';
  if (!(png && vfs.exists(png))) return { ok: false, msg: this._t('cover_not_ready') };
  const cover_word = this.ui_lang === 'en' ? 'cover' : 'обложка';
  const reel = this.last_reel || '';
  const base = (reel && vfs.exists(reel)) ? path.splitext(path.basename(reel))[0] : cover_word + '_' + Math.trunc(now());
  try {
    const dst = `output/${base}_${cover_word}.png`; vfs.copy(png, dst);
    const u = URL.createObjectURL(vfs.read(dst)); const a = document.createElement('a'); a.href = u; a.download = path.basename(dst); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
    log(`🖼 Обложка выгружена: ${path.basename(dst)}`);
    return { ok: true, path: dst, name: path.basename(dst) };
  } catch (e) { log(`  ⚠ выгрузка обложки не удалась: ${String(e.message || e).slice(0, 60)}`); return { ok: false, msg: this._t('cover_save_fail') }; }
};
