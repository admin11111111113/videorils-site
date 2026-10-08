// Порт app.py стр. 449–1115: текст-утилиты, ASS-генерация субтитров (1:1 с десктопом).
import { C, re, pystrip, pylstrip, pysplit, isdigit, vfs } from './core.js';
import { measureText } from './fonts.js';

const { LEAD_JUNK, YELLOW, WHITE, RED, CYAN, PINK, ORANGE, KEYRED, BEIGE, BOX_COLORS } = C;

export function _sanitize_hex(v) {
  const s = pystrip(String(v ?? '')).replace(/^#+/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? '#' + s.toUpperCase() : '';
}

export function _cap_colors_for(hexs) {
  const h = (_sanitize_hex(hexs) || '#000000').replace(/^#+/, '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const dark_plate = lum <= 140;
  const text = dark_plate ? '&H00FFFFFF' : '&H00000000';
  const ass_plate = '&H00' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
  return { ff: `0x${h}@1.0`, text, outline: ass_plate, textcss: dark_plate ? '#FFFFFF' : '#000000', css: '#' + h };
}

export function clean_phrase(text) {
  let t = pystrip(text || '');
  t = pystrip(pylstrip(t, LEAD_JUNK));
  t = re.sub(String.raw`\*+(\S(?:.*?\S)?)\*+`, String.raw`\1`, t);
  t = t.replaceAll('*', '');
  return pystrip(re.sub(String.raw`\s{2,}`, ' ', t));
}

export function _censor_text(s) {
  if (!s || !re.search(C._CENSOR_RE, s)) return s;
  return re.sub(C._CENSOR_RE, (m) => m.group(0).replaceAll('е', '*').replaceAll('Е', '*'), s);
}

export function split_chunks(words, max_words = 3) {
  const res = []; let i = 0; const n = words.length;
  while (i < n) {
    const rem = n - i; let size;
    if (max_words >= 3 && rem === 4) size = 2;
    else if (rem <= max_words) size = rem;
    else size = max_words;
    res.push(words.slice(i, i + size)); i += size;
  }
  return res;
}

export function is_important(word) {
  const w = pystrip(word, LEAD_JUNK);
  if ([...w].some(ch => isdigit(ch))) return true;
  const is_cyr = [...w].some(ch => { const l = ch.toLowerCase(); return (l >= 'а' && l <= 'я') || l === 'ё'; });
  return [...w].length >= (is_cyr ? 8 : 6);
}

export function split_into_phrases(text) {
  text = (text || '').replaceAll('\r', '\n');
  const raw = re.split(String.raw`(?<=[.!?…])\s+|\n+`, text);
  const phrases = [];
  for (const part of raw) {
    const p = clean_phrase(part);
    if (!p) continue;
    const words = pysplit(p);
    if (words.length <= 12) { phrases.push(p); continue; }
    const chunks = re.split(String.raw`(?<=,)\s+`, p);
    let buf = [];
    for (const ch of chunks) {
      buf.push(ch);
      if (pysplit(buf.join(' ')).length >= 9) { phrases.push(clean_phrase(buf.join(' '))); buf = []; }
    }
    if (buf.length) phrases.push(clean_phrase(buf.join(' ')));
  }
  return phrases.filter(Boolean);
}

export function _strip_service_lines(text) {
  const out = [];
  for (const ln of (text || '').replaceAll('\r', '\n').split('\n')) {
    let s = pystrip(ln);
    if (!s) continue;
    const m = re.match(String.raw`^([A-Za-zА-Яа-яЁё]{2,12})\s*\|(.*)$`, s);
    if (m) {
      const head = m.group(1).toUpperCase();
      if (C._SVC_SKIP.has(head)) continue;
      if (C._SVC_PHRASE.some(p => head.startsWith(p))) s = pystrip(m.group(2).split('|')[0]);
    }
    if (re.match(String.raw`^[-–—]?\s*\d+\s*[.):]?$`, s)) continue;
    s = pystrip(re.sub(String.raw`^[-–—•*]?\s*\d+\s*[.):]\s+`, '', s));
    s = pystrip(re.sub(String.raw`^[-–—•]\s+`, '', s));
    const m2 = re.match(String.raw`(?i)^(phrase|фраза|keyword|ключевое\s*слово|topic|тема|desc|описание|подпись|tags|теги|хэштеги|english_query|query|запрос|scene|сцена|sound|звук)\s*#?\s*\d*\s*[:\-–—]\s+(.*)$`, s);
    if (m2) {
      if (['phrase', 'фраза'].includes(m2.group(1).toLowerCase())) s = pystrip(pystrip(pystrip(m2.group(2)), '"«»`'));
      else continue;
    }
    if (s) out.push(s);
  }
  return out.join('\n');
}

export function ass_time(sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  // Python f"{s:05.2f}" — округление half-even на 2 знаках; toFixed близко (half-up по двоичному)
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
export const esc_ass = (text) => text.replaceAll('{', '(').replaceAll('}', ')').replaceAll('\n', ' ');

export function style_line(style, w, h) {
  const ml = style.marginl ?? 60, mr = style.marginr ?? 60;
  const i = (x) => Math.trunc(x);
  return `Style: Main,${style.font},${i(style.size)},${style.primary},${style.secondary},${style.outline_col},${style.back},${i(style.bold ?? 1)},${i(style.italic ?? 0)},0,0,100,100,0,0,${i(style.border)},${i(style.outline)},${i(style.shadow)},${i(style.align)},${i(ml)},${i(mr)},${i(style.marginv)},204`;
}
const _dlg = (cs, ce, text) => `Dialogue: 0,${ass_time(cs)},${ass_time(ce)},Main,,0,0,0,,${text}`;
const I = Math.trunc;

// wt — реальные пословные тайминги [(s,e)] относительно начала строки (Whisper по озвучке):
// аним-стили подсвечивают слово ТОЧНО в момент произношения; seg_idx — № сцены (scene_color)
export function chunk_events(words, hl, style, cs, ce, hook = false, wt = null, seg_idx = 0) {
  const mode = style.mode;
  const up = words.map(w => esc_ass(w.toUpperCase()));
  const is_key = words.map(w => hl.has(pystrip(w, LEAD_JUNK).toUpperCase()) || is_important(w));
  const dur = Math.max(0.05, ce - cs);
  const evs = [];
  const zip = (a, b) => a.map((x, k) => [x, b[k]]);
  const KGREEN = '&H0076E600';
  if (wt && wt.length && ['kf_word', 'jump_word', 'popin_word', 'rise_word', 'keypop_word'].includes(mode)) {
    const _ms = (x) => Math.max(0, Math.trunc(Number(x) * 1000));
    const out = [];
    up.forEach((w, i) => {
      const t0 = i < wt.length ? _ms(wt[i][0]) : Math.trunc(dur * 1000 * i / Math.max(1, up.length));
      const t1 = i < wt.length ? _ms(wt[i][1]) : t0 + 120;
      const key = is_key[i];
      if (mode === 'kf_word') out.push(`{\\c${C.DIMWHITE}\\t(${t0},${t0 + 70},\\c${key ? KGREEN : YELLOW})}${w}{\\r}`);
      else if (mode === 'jump_word') out.push(`{\\c${key ? YELLOW : WHITE}\\t(${t0},${t0 + 90},\\fscx122\\fscy122)\\t(${t0 + 90},${t0 + 240},\\fscx100\\fscy100)}${w}{\\r}`);
      else if (mode === 'popin_word') out.push(`{\\alpha&HFF&\\fscx0\\fscy0\\t(${t0},${t0 + 130},\\alpha&H00&\\fscx100\\fscy100)}${w}{\\r}`);
      else if (mode === 'rise_word') out.push(`{\\alpha&HFF&\\fscy55\\t(${t0},${t0 + 150},\\alpha&H00&\\fscy100)}${w}{\\r}`);
      else if (mode === 'keypop_word') { const sc = key ? 118 : 110; out.push(`{\\c${key ? KGREEN : YELLOW}\\alpha&H55&\\t(${t0},${t0 + 80},\\alpha&H00&\\fscx${sc}\\fscy${sc})\\t(${t0 + 80},${t0 + 230},\\fscx100\\fscy100)}${w}{\\r}`); }
      void t1;
    });
    evs.push(_dlg(cs, ce, out.join(' ')));
    return evs;
  }
  if (mode === 'scene_color') {                       // цвет всей строки меняется по сценам
    const pal = [YELLOW, CYAN, '&H009C2DFF', KGREEN, '&H00FFE500'];
    evs.push(_dlg(cs, ce, `{\\c${pal[seg_idx % pal.length]}}${up.join(' ')}`));
    return evs;
  }
  if (hook) {
    const big = I(style.size * 1.18);
    const pre = `{\\fs${big}\\bord${I(style.outline + 1)}\\fscx72\\fscy72\\t(0,150,\\fscx100\\fscy100)}`;
    evs.push(_dlg(cs, ce, pre + up.join(' ')));
    return evs;
  }
  if (mode === 'pop') {
    evs.push(_dlg(cs, ce, '{\\fscx40\\fscy40\\t(0,120,\\fscx100\\fscy100)}' + up.join(' ')));
  } else if (mode === 'karaoke') {
    const per = Math.max(6, I(dur * 100 / up.length));
    evs.push(_dlg(cs, ce, up.map(w => `{\\kf${per}}${w} `).join('').trim()));
  } else if (mode === 'highlight') {
    const out = zip(up, is_key).map(([w, key]) => key ? `{\\c${RED}\\fs${I(style.size * 1.22)}\\bord10}${w}{\\r}` : `{\\c${WHITE}}${w}{\\r}`);
    evs.push(_dlg(cs, ce, out.join(' ')));
  } else if (mode === 'boxes') {
    const per = dur / up.length;
    up.forEach((w, i) => {
      const ws = cs + i * per; const box = BOX_COLORS[i % BOX_COLORS.length];
      evs.push(_dlg(ws, ce, `{\\3c${box}\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}${w}`));
    });
  } else if (mode === 'neon') {
    evs.push(_dlg(cs, ce, up.join(' ')));
  } else if (mode === 'jump') {
    const out = up.map((w, i) => `{\\c${i % 2 === 0 ? YELLOW : WHITE}}${w}{\\r}`);
    evs.push(_dlg(cs, ce, '{\\fscy55\\frz-3\\t(0,140,\\fscy105\\frz0)\\t(140,210,\\fscy100)}' + out.join(' ')));
  } else if (mode === 'typewriter') {
    const per = dur / up.length;
    for (let i = 0; i < up.length; i++) evs.push(_dlg(cs + i * per, ce, up.slice(0, i + 1).join(' ') + '{\\alpha&HFF&}_'));
  } else if (mode === 'mix') {
    const out = zip(up, is_key).map(([w, key], i) => key ? `{\\i1\\fnSegoe Script\\c${CYAN}\\fs${I(style.size * 1.1)}}${w}{\\r}`
      : (i % 2 === 1 ? `{\\i1\\fnSegoe Script\\fs${I(style.size * 0.92)}}${w}{\\r}` : `{\\b1\\c${YELLOW}}${w}{\\r}`));
    evs.push(_dlg(cs, ce, out.join(' ')));
  } else if (mode === 'wave') {
    const palette = [YELLOW, PINK, CYAN]; const ms = I(dur * 1000);
    evs.push(_dlg(cs, ce, up.map((w, i) => `{\\c${palette[i % 3]}\\t(0,${ms},\\c${palette[(i + 1) % 3]})}${w}{\\r}`).join(' ')));
  } else if (mode === 'zoom') {
    const out = zip(up, is_key).map(([w, key]) => key ? `{\\fscx190\\fscy190\\bord16\\t(0,100,\\fscx100\\fscy100\\bord10)}${w}{\\r}` : `{\\fscx150\\fscy150\\t(0,90,\\fscx100\\fscy100)}${w}{\\r}`);
    evs.push(_dlg(cs, ce, out.join(' ')));
  } else if (mode === 'keyhl') {
    const kc = style.keycol ?? YELLOW, tc = style.keytext ?? WHITE, ksc = Number(style.keyscale ?? 1.18);
    const out = zip(up, is_key).map(([w, key]) => {
      if (!key) return w;
      let tag;
      if (style.keybox) tag = `\\c${tc}\\3c${kc}\\bord16\\fs${I(style.size * ksc)}`;
      else if (style.keypop) { const pct = I(ksc * 100); tag = `\\c${kc}\\fscx40\\fscy40\\t(0,150,\\fscx${pct}\\fscy${pct})`; }
      else {
        tag = `\\c${kc}\\fs${I(style.size * ksc)}`;
        if (style.keyglow) tag += '\\blur5';
        if (style.keyunderline) tag += `\\u1\\3c${style.keyu_col ?? kc}\\bord4`;
      }
      return `{${tag}}${w}{\\r}`;
    });
    evs.push(_dlg(cs, ce, out.join(' ')));
  } else if (mode === 'halfcolor') {
    const c1 = style.col1 ?? CYAN, c2 = style.col2 ?? PINK; const mid = Math.max(1, Math.floor((up.length + 1) / 2));
    evs.push(_dlg(cs, ce, up.map((w, i) => `{\\c${i < mid ? c1 : c2}}${w}{\\r}`).join(' ')));
  } else if (mode === 'leftbar') {
    evs.push(_dlg(cs, ce, `{\\c${style.barcol ?? KEYRED}}▌{\\r} ${up.join(' ')}`));
  } else if (mode === 'glitch') {
    evs.push(_dlg(cs, ce, zip(up, is_key).map(([w, key]) => key ? `{\\fnConsolas\\c${CYAN}\\frz2\\fscx112}${w}{\\r}` : w).join(' ')));
  } else if (mode === 'neonglow') {
    evs.push(_dlg(cs, ce, '{\\blur4}' + up.join(' ')));
  } else if (mode === 'gradglow') {
    evs.push(_dlg(cs, ce, up.map((w, i) => `{\\c${i % 2 === 0 ? YELLOW : ORANGE}\\blur3}${w}{\\r}`).join(' ')));
  } else if (mode === 'twocolor') {
    const mid = Math.max(1, Math.floor((up.length + 1) / 2));
    const top = up.slice(0, mid).join(' '), bot = up.slice(mid).join(' ');
    const tcol = style.twocol ?? BEIGE;
    evs.push(_dlg(cs, ce, bot ? `{\\b1\\c${WHITE}}${top}{\\r}\\N{\\i1\\fnSegoe Script\\fs${I(style.size * 0.7)}\\c${tcol}}${bot}{\\r}` : `{\\b1\\c${WHITE}}${top}{\\r}`));
  } else {
    evs.push(_dlg(cs, ce, up.join(' ')));
  }
  return evs;
}

// --- ГАРАНТИЯ «субтитр всегда в кадре по ширине» (замер шрифта) ---
export function _text_px(text, font_name, size) {
  try { return measureText(text, font_name, Math.max(1, I(size)), true); } catch (e) { return null; }
}

export function _fit_style_size(segments, style, w, max_words, hook_first = false) {
  const size = I(style.size ?? 90);
  const ml = style.marginl ?? 60, mr = style.marginr ?? 60;
  const usable = Math.max(50.0, (w - ml - mr) * 0.97);
  const mode = style.mode ?? '';
  let base_mult = mode === 'highlight' ? 1.22 : (mode === 'mix' ? 1.1 : 1.0);
  if (mode === 'keyhl') base_mult = Math.max(base_mult, Number(style.keyscale ?? 1.0));
  const font = style.font ?? 'Arial Black';
  let worst_ratio = 0.0;
  (segments || []).forEach((seg, k) => {
    const si = k + 1;
    const words = pysplit(clean_phrase(seg.text ?? '').toUpperCase());
    for (const chunk of split_chunks(words, max_words)) {
      const px = _text_px(chunk.join(' '), font, size);
      if (px === null) { worst_ratio = -1; return; }
      let mult = base_mult;
      if (hook_first && si === 1) mult = Math.max(mult, 1.18);
      if (px > 0) worst_ratio = Math.max(worst_ratio, (px * mult) / usable);
    }
  });
  if (worst_ratio < 0) return size;
  if (worst_ratio <= 1.9) return size;
  return Math.max(28, I(size / (worst_ratio / 1.9)));
}

export function build_ass(path, segments, style, w, h, highlights_map, win_start = null, win_end = null, max_words = 3, hook_first = false, word_times = null) {
  style = Object.assign({}, style);
  style.size = _fit_style_size(segments, style, w, max_words, hook_first);
  const head = ['[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 0', `PlayResX: ${w}`, `PlayResY: ${h}`, 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style_line(style, w, h), '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const events = [];
  const offset = win_start !== null ? -win_start : 0.0;
  let gwi = 0;                                  // глобальный индекс слова в word_times
  segments.forEach((seg, k) => {
    const idx = k + 1;
    const s = Number(seg.start), e = Number(seg.end);
    const text = _censor_text(clean_phrase(seg.text));
    const words = pysplit(text);
    if (!words.length || (win_end !== null && (e < win_start || s > win_end))) { gwi += words.length; return; }
    const hl = highlights_map[idx] instanceof Set ? highlights_map[idx] : new Set(highlights_map[idx] || []);
    const chunks = split_chunks(words, max_words);
    const seg_dur = Math.max(0.2, e - s); const total = words.length;
    const is_hook = hook_first && idx === 1;
    let t = s;
    for (const chunk of chunks) {
      const n_ch = chunk.length; let wt_rel = null, cs, ce;
      if (word_times && gwi + n_ch <= word_times.length) {
        const wtimes = word_times.slice(gwi, gwi + n_ch); const w0 = Number(wtimes[0][0]);
        cs = Math.max(0.0, w0 + offset); ce = Math.max(cs + 0.08, Number(wtimes[wtimes.length - 1][1]) + offset);
        wt_rel = wtimes.map(([ws, we]) => [Number(ws) - w0, Number(we) - w0]);
        t = Number(wtimes[wtimes.length - 1][1]);
      } else {
        const cdur = seg_dur * n_ch / total;
        cs = Math.max(0.0, t + offset); ce = Math.max(cs + 0.08, t + cdur + offset);
        t += cdur;
      }
      gwi += n_ch;
      events.push(...chunk_events(chunk, hl, style, cs, ce, is_hook, wt_rel, idx - 1));
    }
  });
  const txt = [...head, ...events].join('\n');
  if (path) vfs.writeText(path, txt);
  return txt;
}

// слова СУБТИТРОВ -> реальные тайминги Whisper [(w,s,e)] по озвучке; монотонное отображение индексов
export function align_sub_words(sub_words, whisper_words) {
  const N = sub_words.length, M = whisper_words.length;
  if (!N || !M) return [];
  if (N === 1) return [[Number(whisper_words[0][1]), Number(whisper_words[M - 1][2])]];
  const out = [];
  for (let i = 0; i < N; i++) { const j = Math.max(0, Math.min(M - 1, Math.round(i * (M - 1) / (N - 1)))); out.push([Number(whisper_words[j][1]), Number(whisper_words[j][2])]); }
  for (let i = 1; i < N; i++) if (out[i][0] < out[i - 1][0]) out[i] = [out[i - 1][0], Math.max(out[i - 1][0] + 0.05, out[i][1])];
  return out;
}
