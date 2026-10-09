// Отрисовщик ASS-субтитров на canvas — замена ffmpeg "-vf ass=" (libass) для веба.
// Поддержан тот набор, что генерирует chunk_events/build_ass десктопа:
// \fs \bord \shad \fscx \fscy \t(t1,t2,…) \c/\1c \3c \4c \alpha \1a \3a \r \kf/\k \frz \i \b \fn \blur \u \N,
// BorderStyle 1 (обводка+тень) и 3 (плашка), Alignment 1-9, WrapStyle 0 (умный перенос),
// PlayRes = размер кадра, ScaledBorderAndShadow: yes.
import { cssFont, FONT_MAP } from './fonts.js';

// libass задаёт кегль ASS как ПОЛНУЮ высоту шрифта (usWinAscent+usWinDescent), а не em:
// em = Fontsize × upem/(winAsc+winDesc). Метрики — по шрифтам ДЕСКТОПА (их видит libass в
// приложении), чтобы размер и межстрочие совпадали с готовым видео приложения.
const FONT_METRICS = {
  'Arial Black': { asc: 2254, desc: 634, upem: 2048 },
  'Segoe Script': { asc: 2230, desc: 1014, upem: 2048 },
  'Consolas': { asc: 1884, desc: 514, upem: 2048, cal: 0.917 },   // JetBrains Mono шире Consolas
};
function fm(fn) { return FONT_METRICS[fontName(fn)] || FONT_METRICS['Arial Black']; }
function emOf(fn, fs) { const m = fm(fn); return fs * m.upem / (m.asc + m.desc) * (m.cal || 1); }
function ascOf(fn) { const m = fm(fn); return m.asc / (m.asc + m.desc); }
function descOf(fn) { const m = fm(fn); return m.desc / (m.asc + m.desc); }
const ITALIC_SHEAR = 0.2126;          // синтетический курсив FreeType (как libass)

function assColor(s) {               // &HAABBGGRR | &HBBGGRR -> {r,g,b,a(0..1 непрозр.)}
  let h = String(s || '').replace(/^&H/i, '').replace(/&$/, '');
  h = h.padStart(8, '0').slice(-8);
  const a = parseInt(h.slice(0, 2), 16), b = parseInt(h.slice(2, 4), 16), g = parseInt(h.slice(4, 6), 16), r = parseInt(h.slice(6, 8), 16);
  return { r, g, b, a: 1 - a / 255 };
}
const rgba = (c, mul = 1) => `rgba(${c.r},${c.g},${c.b},${(c.a * mul).toFixed(3)})`;
function parseTime(t) { const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0; }

export function parseASS(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const info = {}, styles = {}; const events = [];
  let section = '', sfmt = [], efmt = [];
  for (const ln of lines) {
    const t = ln.trim(); if (!t) continue;
    if (t.startsWith('[')) { section = t.toLowerCase(); continue; }
    const i = t.indexOf(':'); if (i < 0) continue;
    const key = t.slice(0, i).trim(), val = t.slice(i + 1).trim();
    if (section === '[script info]') info[key] = val;
    else if (section.includes('styles')) {
      if (key === 'Format') sfmt = val.split(',').map(s => s.trim());
      else if (key === 'Style') { const p = val.split(','); const o = {}; sfmt.forEach((f, k) => o[f] = (p[k] ?? '').trim()); styles[o.Name] = o; }
    } else if (section === '[events]') {
      if (key === 'Format') efmt = val.split(',').map(s => s.trim());
      else if (key === 'Dialogue') {
        const p = val.split(','); const o = {}; const n = efmt.length;
        efmt.forEach((f, k) => o[f] = k === n - 1 ? p.slice(k).join(',') : (p[k] ?? '').trim());
        events.push({ layer: +o.Layer || 0, start: parseTime(o.Start), end: parseTime(o.End), style: o.Style, text: o.Text, ml: +o.MarginL || 0, mr: +o.MarginR || 0, mv: +o.MarginV || 0 });
      }
    }
  }
  const W = +info.PlayResX || 1080, H = +info.PlayResY || 1920;
  const st = {};
  for (const [name, s] of Object.entries(styles)) {
    st[name] = {
      fn: s.Fontname, fs: +s.Fontsize, c1: assColor(s.PrimaryColour), c2: assColor(s.SecondaryColour), c3: assColor(s.OutlineColour), c4: assColor(s.BackColour),
      b: +s.Bold !== 0, i: +s.Italic !== 0, u: +s.Underline !== 0, fscx: +s.ScaleX || 100, fscy: +s.ScaleY || 100, spacing: +s.Spacing || 0, frz: +s.Angle || 0,
      borderStyle: +s.BorderStyle || 1, bord: +s.Outline || 0, shad: +s.Shadow || 0, align: +s.Alignment || 2, ml: +s.MarginL || 0, mr: +s.MarginR || 0, mv: +s.MarginV || 0,
      blur: 0, alpha1: null, alpha3: null,
    };
  }
  const wrapStyle = +(info.WrapStyle ?? 0);
  return { W, H, styles: st, events: events.map(e => compileEvent(e, st[e.style] || Object.values(st)[0])), wrapStyle };
}

const ANIM = ['fs', 'bord', 'shad', 'fscx', 'fscy', 'frz', 'blur'];
function parseOverride(block, cur, style, transforms) {
  // block — содержимое {...}; изменяет cur, \t добавляет в transforms
  let i = 0; const s = block;
  while (i < s.length) {
    if (s[i] !== '\\') { i++; continue; }
    i++;
    // \t(...)
    if (s[i] === 't' && s[i + 1] === '(') {
      let depth = 0, j = i + 1; for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') { depth--; if (depth === 0) break; } }
      const inner = s.slice(i + 2, j); i = j + 1;
      const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,(?:\s*([\d.]+)\s*,)?(.*)$/s.exec(inner);
      let t1 = 0, t2 = null, accel = 1, tags = inner;
      if (m) { t1 = +m[1]; t2 = +m[2]; accel = m[3] ? +m[3] : 1; tags = m[4]; }
      const target = {}; parseOverride(tags, target, style, null);
      transforms.push({ t1, t2, accel, target });
      continue;
    }
    const m = /^(1c|2c|3c|4c|1a|3a|alpha|fscx|fscy|fsp|fs|fn|bord|shad|blur|be|frz|fr|kf|ko|K|k|c|b|i|u|s|r|N|n|h|a|an)/.exec(s.slice(i));
    if (!m) { i++; continue; }
    const tag = m[1]; i += tag.length;
    let arg = ''; if (tag === 'fn' || tag === 'r') { const k = s.indexOf('\\', i); arg = (k < 0 ? s.slice(i) : s.slice(i, k)); i = k < 0 ? s.length : k; }
    else { const mm = /^(&H[0-9A-Fa-f]+&?|-?[\d.]+)?/.exec(s.slice(i)); arg = mm[0] || ''; i += arg.length; }
    switch (tag) {
      case 'fs': cur.fs = +arg; break;
      case 'fscx': cur.fscx = +arg; break;
      case 'fscy': cur.fscy = +arg; break;
      case 'bord': cur.bord = +arg; break;
      case 'shad': cur.shad = +arg; break;
      case 'blur': case 'be': cur.blur = +arg; break;
      case 'frz': case 'fr': cur.frz = +arg; break;
      case 'c': case '1c': cur.c1 = assColor(arg); break;
      case '2c': cur.c2 = assColor(arg); break;
      case '3c': cur.c3 = assColor(arg); break;
      case '4c': cur.c4 = assColor(arg); break;
      case 'alpha': { const a = 1 - parseInt(arg.replace(/&H|&/gi, '') || '0', 16) / 255; cur.alphaAll = a; break; }
      case '1a': cur.alpha1 = 1 - parseInt(arg.replace(/&H|&/gi, '') || '0', 16) / 255; break;
      case '3a': cur.alpha3 = 1 - parseInt(arg.replace(/&H|&/gi, '') || '0', 16) / 255; break;
      case 'b': cur.b = arg !== '0' && arg !== ''; break;
      case 'i': cur.i = arg !== '0' && arg !== ''; break;
      case 'u': cur.u = arg !== '0' && arg !== ''; break;
      case 'fn': cur.fn = arg.trim(); break;
      case 'kf': case 'K': cur.kType = 'kf'; cur.kDur = (+arg) * 10; break;
      case 'k': case 'ko': cur.kType = 'k'; cur.kDur = (+arg) * 10; break;
      case 'r': if (transforms) { cur.__reset = true; } break;
      case 'an': cur.an = +arg; break;
      default: break;
    }
  }
}
function baseState(style) {
  return { fn: style.fn, fs: style.fs, c1: style.c1, c2: style.c2, c3: style.c3, c4: style.c4, b: style.b, i: style.i, u: style.u, fscx: style.fscx, fscy: style.fscy,
    bord: style.bord, shad: style.shad, blur: style.blur, frz: style.frz, alphaAll: null, alpha1: null, alpha3: null };
}
function compileEvent(ev, style) {
  // текст -> runs [{text, state, transforms, kStart, kDur, kType}] + переносы \N
  const runs = []; let state = baseState(style); let transforms = []; let kAcc = 0; let an = style.align;
  const src = ev.text;
  let i = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      const j = src.indexOf('}', i); const block = j < 0 ? src.slice(i + 1) : src.slice(i + 1, j); i = j < 0 ? src.length : j + 1;
      const nt = []; const ns = Object.assign({}, state);
      ns.kType = undefined; ns.kDur = undefined; ns.__reset = false; ns.an = undefined;
      // \r сбрасывает к стилю ДО применения остальных тегов блока
      if (/\\r(?=\\|$)/.test(block)) { Object.assign(ns, baseState(style)); transforms = []; delete ns.kStart; }
      parseOverride(block, ns, style, nt);
      if (ns.an) an = ns.an;
      if (ns.kDur !== undefined) { ns.kStart = kAcc; kAcc += ns.kDur; }
      delete ns.__reset;
      state = ns; transforms = transforms.concat(nt);
      continue;
    }
    let j = src.indexOf('{', i); if (j < 0) j = src.length;
    let txt = src.slice(i, j); i = j;
    const parts = txt.split(/\\N|\\n/);
    parts.forEach((p, k) => {
      if (k > 0) runs.push({ br: true });
      if (p) runs.push({ text: p.replace(/\\h/g, ' '), state: Object.assign({}, state), transforms: transforms.slice() });
    });
    // \k действует только на следующий кусок текста
    if (state.kStart !== undefined) { state = Object.assign({}, state); }
  }
  return Object.assign({}, ev, { runs, an, styleRef: style });
}

function lerp(a, b, k) { return a + (b - a) * k; }
function lerpColor(a, b, k) { return { r: Math.round(lerp(a.r, b.r, k)), g: Math.round(lerp(a.g, b.g, k)), b: Math.round(lerp(a.b, b.b, k)), a: lerp(a.a, b.a, k) }; }
function animState(run, tMs, evDurMs) {
  const s = Object.assign({}, run.state);
  for (const tr of run.transforms) {
    const t2 = tr.t2 === null || tr.t2 === undefined || (tr.t1 === 0 && tr.t2 === 0) ? evDurMs : tr.t2;
    let k = t2 <= tr.t1 ? (tMs >= tr.t1 ? 1 : 0) : Math.min(1, Math.max(0, (tMs - tr.t1) / (t2 - tr.t1)));
    if (tr.accel !== 1) k = Math.pow(k, tr.accel);
    for (const [key, v] of Object.entries(tr.target)) {
      if (ANIM.includes(key)) s[key] = lerp(s[key] ?? 0, v, k);
      else if (key === 'c1' || key === 'c2' || key === 'c3' || key === 'c4') s[key] = lerpColor(s[key], v, k);
      else if (key === 'alphaAll' || key === 'alpha1' || key === 'alpha3') s[key] = lerp(s[key] ?? 1, v, k);
    }
  }
  return s;
}

let _m = null;
function mctx() { if (!_m) _m = new OffscreenCanvas(8, 8).getContext('2d'); return _m; }
function fontName(fn) { return FONT_MAP[fn] ? fn : 'Arial Black'; }
function runWidth(text, s) { const c = mctx(); c.font = cssFont(fontName(s.fn), Math.max(1, emOf(s.fn, s.fs))); return c.measureText(text).width * (s.fscx / 100); }

// Раскладка события в строки (с умным переносом WrapStyle 0)
function layout(ev, states, maxW) {
  // слова = куски runs, разбитые по пробелам (пробел остаётся при слове)
  const items = []; // {text, state, ri, w, space, br}
  ev.runs.forEach((r, ri) => {
    if (r.br) { items.push({ br: true }); return; }
    const st = states[ri];
    const toks = r.text.split(/( +)/).filter(x => x !== '');
    for (const tk of toks) items.push({ text: tk, ri, st, isSpace: /^ +$/.test(tk), w: runWidth(tk, st) });
  });
  // жёсткие переносы делят на абзацы
  const paras = [[]]; for (const it of items) { if (it.br) paras.push([]); else paras[paras.length - 1].push(it); }
  const lines = [];
  for (const para of paras) {
    // слова (группы без пробелов) для переноса
    const words = []; let cur = { parts: [], w: 0, spaceAfter: null };
    for (const it of para) {
      if (it.isSpace) { cur.spaceAfter = it; words.push(cur); cur = { parts: [], w: 0, spaceAfter: null }; }
      else { cur.parts.push(it); cur.w += it.w; }
    }
    if (cur.parts.length) words.push(cur);
    const wsum = (a, b) => { let w = 0; for (let k = a; k < b; k++) { w += words[k].w; if (k < b - 1 && words[k].spaceAfter) w += words[k].spaceAfter.w; } return w; };
    const n = words.length; if (!n) { lines.push([]); continue; }
    // жадно -> число строк, затем балансировка (минимум максимальной ширины) как libass WrapStyle 0
    let cnt = 1, acc = 0;
    for (let k = 0; k < n; k++) { const add = words[k].w + (acc > 0 && words[k - 1].spaceAfter ? words[k - 1].spaceAfter.w : 0); if (acc > 0 && acc + add > maxW) { cnt++; acc = words[k].w; } else acc += add; }
    let breaks = [];
    if (cnt > 1) {
      const memo = new Map();
      const best = (start, left) => {
        const key = start + ',' + left; if (memo.has(key)) return memo.get(key);
        let res;
        if (left === 1) res = { cost: wsum(start, n), br: [] };
        else {
          res = { cost: Infinity, br: [] };
          for (let e = start + 1; e <= n - left + 1; e++) { const w = wsum(start, e); const sub = best(e, left - 1); const c = Math.max(w, sub.cost); if (c < res.cost) res = { cost: c, br: [e, ...sub.br] }; }
        }
        memo.set(key, res); return res;
      };
      breaks = best(0, cnt).br;
    }
    let a = 0; for (const b of [...breaks, n]) { const ln = []; for (let k = a; k < b; k++) { ln.push(...words[k].parts); if (k < b - 1 && words[k].spaceAfter) ln.push(words[k].spaceAfter); } lines.push(ln); a = b; }
  }
  return lines;
}

export class AssRenderer {
  constructor(assText) { this.doc = parseASS(assText); }
  // рисует все активные события на момент t (сек) в ctx (кадр doc.W×doc.H)
  draw(ctx, t) {
    const { doc } = this;
    const active = doc.events.filter(e => t >= e.start && t < e.end).sort((a, b) => a.layer - b.layer);
    for (const ev of active) this._drawEvent(ctx, ev, (t - ev.start) * 1000, (ev.end - ev.start) * 1000);
  }
  _drawEvent(ctx, ev, tMs, durMs) {
    const style = ev.styleRef; const W = this.doc.W, H = this.doc.H;
    const ml = ev.ml || style.ml, mr = ev.mr || style.mr, mv = ev.mv || style.mv;
    const states = ev.runs.map(r => r.br ? null : animState(r, tMs, durMs));
    // перенос — по ТЕКУЩИМ размерам кадра: libass переразбивает строки на каждом кадре
    // (у хука с \fscx72→100 в начале одна строка, после анимации может стать две)
    const maxW = W - ml - mr;
    const linesF = layout(ev, states, maxW);
    // текущая (анимированная) раскладка тех же строк
    const lines = linesF.map(ln => ln.map(it => { const st = states[it.ri]; return Object.assign({}, it, { st, w: runWidth(it.text, st) }); }));
    const lineMetrics = lines.map(ln => {
      let w = 0, asc = 0, desc = 0;
      for (const it of ln) { w += it.w; const fsY = it.st.fs * it.st.fscy / 100; asc = Math.max(asc, fsY * ascOf(it.st.fn)); desc = Math.max(desc, fsY * descOf(it.st.fn)); }
      if (!ln.length) { const fsY = style.fs; asc = fsY * ascOf(style.fn); desc = fsY * descOf(style.fn); }
      return { w, asc, desc };
    });
    const totalH = lineMetrics.reduce((a, m) => a + m.asc + m.desc, 0);
    const an = ev.an || style.align; const col = (an - 1) % 3, row = Math.floor((an - 1) / 3);   // row 0=низ,1=центр,2=верх
    let y0;
    if (row === 0) y0 = H - mv - totalH; else if (row === 2) y0 = mv; else y0 = (H - totalH) / 2;
    const frz = (states.find(s => s) || {}).frz || 0;
    ctx.save();
    if (frz) {   // поворот вокруг точки привязки строки (как libass org по умолчанию)
      const ox = col === 0 ? ml : col === 2 ? W - mr : (ml + W - mr) / 2; const oy = row === 0 ? H - mv : row === 2 ? mv : H / 2;
      ctx.translate(ox, oy); ctx.rotate(-frz * Math.PI / 180); ctx.translate(-ox, -oy);
    }
    // проходы: тень -> обводка/плашка -> заливка (как libass)
    const placed = []; let y = y0;
    lines.forEach((ln, li) => {
      const m = lineMetrics[li]; const base = y + m.asc;
      let x = col === 0 ? ml : col === 2 ? W - mr - m.w : ml + (maxW - m.w) / 2;
      for (const it of ln) { placed.push({ it, x, base, line: li }); x += it.w; }
      y += m.asc + m.desc;
    });
    const bs = style.borderStyle;
    if (bs === 3) {
      // плашка на каждую строку: цвет обводки, отступ = bord; тень плашки — цвет тени
      lines.forEach((ln, li) => {
        if (!ln.length) return;
        const items = placed.filter(p => p.line === li); const st = items[0].it.st;
        const m = lineMetrics[li]; const x0 = items[0].x, x1 = items[items.length - 1].x + items[items.length - 1].it.w;
        const top = items[0].base - m.asc, bot = items[0].base + m.desc; const pad = st.bord;
        const a = st.alphaAll ?? 1;
        if (st.shad > 0) { ctx.fillStyle = rgba(st.c4, a); ctx.fillRect(x0 - pad + st.shad, top - pad + st.shad, x1 - x0 + 2 * pad, bot - top + 2 * pad); }
        ctx.fillStyle = rgba(st.c3, a * (st.alpha3 ?? 1)); ctx.fillRect(x0 - pad, top - pad, x1 - x0 + 2 * pad, bot - top + 2 * pad);
      });
    }
    for (const pass of ['shadow', 'outline', 'fill']) {
      for (const p of placed) {
        const { it, x, base } = p; const st = it.st; if (it.isSpace && pass === 'fill' && !st.u) continue;
        const a = st.alphaAll ?? 1;
        ctx.save();
        ctx.translate(x, base);
        ctx.scale(st.fscx / 100, st.fscy / 100);
        if (st.i) ctx.transform(1, 0, -ITALIC_SHEAR, 1, 0, 0);
        const em = emOf(st.fn, st.fs);
        ctx.font = cssFont(fontName(st.fn), Math.max(1, em));
        ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
        const sx = 100 / st.fscx;          // обводка/тень в пикселях кадра, не в масштабе текста
        const bord = bs === 3 ? 0 : st.bord;
        const blur = st.blur || 0;
        const embolden = st.b ? Math.max(1, em / 24) : 0;   // синтетический bold (FreeType embolden = em/24)
        if (pass === 'shadow' && bs !== 3 && st.shad > 0) {
          ctx.save(); ctx.translate(st.shad * sx, st.shad * (100 / st.fscy));
          if (blur) ctx.filter = `blur(${blur * 0.6}px)`;
          ctx.fillStyle = rgba(st.c4, a); ctx.strokeStyle = rgba(st.c4, a);
          if (bord > 0) { ctx.lineWidth = (bord * 2 + embolden) * sx; ctx.strokeText(it.text, 0, 0); }
          ctx.fillText(it.text, 0, 0);
          ctx.restore();
        } else if (pass === 'outline' && bord > 0) {
          if (blur) ctx.filter = `blur(${blur * 0.6}px)`;
          ctx.strokeStyle = rgba(st.c3, a * (st.alpha3 ?? 1)); ctx.lineWidth = (bord * 2 + embolden) * sx; ctx.strokeText(it.text, 0, 0);
          if (st.u) { const uw = it.w * sx; ctx.fillStyle = rgba(st.c3, a); ctx.fillRect(-bord * sx, em * 0.1 - bord, uw + 2 * bord * sx, em * 0.07 + 2 * bord); }
        } else if (pass === 'fill') {
          if (blur && bord === 0) ctx.filter = `blur(${blur * 0.6}px)`;
          let fill = rgba(st.c1, a * (st.alpha1 ?? 1));
          if (st.kStart !== undefined) {   // караоке: спетое — primary, не спетое — secondary
            const k0 = st.kStart, k1 = st.kStart + (st.kDur || 0);
            if (tMs < k0) fill = rgba(st.c2, a);
            else if (st.kType === 'kf' && tMs < k1) {
              const fr = (tMs - k0) / Math.max(1, k1 - k0); const ww = it.w * sx;
              ctx.save(); ctx.beginPath(); ctx.rect(-50, -st.fs * 2, ww * fr + 50, st.fs * 4); ctx.clip();
              ctx.fillStyle = fill; ctx.fillText(it.text, 0, 0); ctx.restore();
              ctx.save(); ctx.beginPath(); ctx.rect(ww * fr, -st.fs * 2, ww * (1 - fr) + 50, st.fs * 4); ctx.clip();
              ctx.fillStyle = rgba(st.c2, a); ctx.fillText(it.text, 0, 0); ctx.restore();
              ctx.restore(); continue;
            }
          }
          ctx.fillStyle = fill;
          if (embolden) { ctx.strokeStyle = fill; ctx.lineWidth = embolden * sx; ctx.strokeText(it.text, 0, 0); }
          ctx.fillText(it.text, 0, 0);
          if (st.u) ctx.fillRect(0, em * 0.1, it.w * sx, em * 0.07);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }
}
