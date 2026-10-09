// Порт Api: импорт аудио/видео, распознавание (faster-whisper small int8 -> transformers.js
// whisper-small q8, кэш в браузере), word-тайминги «Мой голос», выравнивание (app.py 8801–9006, 11133–11247).
import { C, log, vfs, path, call_js, bar, pickFiles, re } from './core.js';
import * as A from './audio.js';
import { Api } from './api_base.js';
import { clean_phrase } from './textutil.js';

const P = Api.prototype;
const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm';   // +esm: переписаны импорты onnxruntime-web
const MODEL = 'onnx-community/whisper-small_timestamped';
// Whisper — в ФОНОВОМ потоке (whisper_worker.js): страница не замирает и Chrome не предлагает
// «закрыть страницу» во время распознавания. Снаружи — тот же вызов asr(audio, opts).
let _asr = null, _wk = null, _seq = 0; const _wait = new Map(); let _prog = null;
function _worker() {
  if (_wk) return _wk;
  _wk = new Worker(new URL('./whisper_worker.js', import.meta.url), { type: 'module' });
  _wk.onmessage = (e) => { const d = e.data || {};
    if (d.type === 'progress') { try { _prog && _prog(d.frac); } catch (x) { } return; }
    const w = _wait.get(d.id); if (!w) return; _wait.delete(d.id); d.ok ? w.res(d.result) : w.rej(new Error(d.error || 'whisper error')); };
  _wk.onerror = (e) => { for (const w of _wait.values()) w.rej(new Error(e.message || 'whisper worker error')); _wait.clear(); _wk = null; _asr = null; };
  return _wk;
}
function _call(op, audio, opts) {
  const id = ++_seq; const wk = _worker();
  return new Promise((res, rej) => { _wait.set(id, { res, rej }); const a = audio ? audio.slice() : null; wk.postMessage({ id, op, audio: a, opts }, a ? [a.buffer] : []); });
}
async function loadWhisper(progress) {
  if (_asr) return _asr;
  _prog = progress || null;
  await _call('load');
  const fn = (audio, opts) => _call('run', audio, opts);
  fn.detect = (audio) => _call('detect', audio);
  _asr = fn;
  return _asr;
}
// Автоопределение языка (как faster-whisper: первый токен декодера после <|startoftranscript|>
// на первых 30с). transformers.js без явного языка подставляет английский — поэтому сами.
const WL = ['en','zh','de','es','ru','ko','fr','ja','pt','tr','pl','ca','nl','ar','sv','it','id','hi','fi','vi','he','uk','el','ms','cs','ro','da','hu','ta','no','th','ur','hr','bg','lt','la','mi','ml','cy','sk','te','fa','lv','bn','sr','az','sl','kn','et','mk','br','eu','is','hy','ne','mn','bs','kk','sq','sw','gl','mr','pa','si','km','sn','yo','so','af','oc','ka','be','tg','sd','gu','am','yi','lo','uz','fo','ht','ps','tk','nn','mt','sa','lb','my','bo','tl','mg','as','tt','haw','ln','ha','ba','jw','su'];
async function detectLanguage(asr, audio) { return await asr.detect(audio); }   // считает фоновый поток
// WAV 16 кГц моно (как extract_audio_wav) -> Float32Array
async function pcm16k(p) { const b = await A.resample(await A.decode(p), 16000, 1); return b.getChannelData(0); }
async function hasAudio(p) { try { const b = await A.decode(p); return b.duration > 0.05; } catch (e) { return false; } }

P.find_audio_on_desktop = function () { return { ok: false, msg: this._t('no_desktop_audio') }; };
P.choose_audio_file = function (scope = 'video') {
  return pickFiles('video/*,audio/*,.mp4,.mkv,.webm,.mov,.avi,.aac,.mp3,.m4a,.wav').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    return await this._import_audio(files[0], scope);
  });
};
P._audio_path_for = function (scope) { return scope === 'foreign' ? this.foreign_audio_path : this.audio_path; };
P._import_audio = async function (file, scope = 'video') {
  try {
    const name = file.name || 'input.mp4'; const dst = `input/${name}`;
    vfs.write(dst, file);
    if (scope === 'foreign') {
      this.foreign_audio_path = dst; this.foreign_segments = []; this.foreign_cap_zone = null;
      try { this._persist(); } catch (e) { }
    } else this.audio_path = dst;
    const dur = await A.duration(dst);
    if (scope === 'foreign') this._foreign_src_dur = dur;     // ffprobe_duration-кэш для _target_sec
    return { ok: true, name, dur: Math.round(dur * 10) / 10 };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.on_drop = async function (file) { const res = await this._import_audio(file, 'foreign'); call_js('droppedImported', res); return res; };
P.transcribe = async function (scope = 'video') {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  const p = this._audio_path_for(scope);
  if (!p) return { ok: false, msg: this._t('select_audio_first') };
  if (!(await hasAudio(p))) {
    log(`  ℹ распознавание: в файле нет аудио — пустой результат (${path.basename(p)})`);
    if (scope === 'foreign') this.foreign_segments = []; else if (scope === 'reel') this.reel_segments = []; else this.segments = [];
    call_js('transcribeLoading', false); call_js('transcribeDone', 0, scope);
    return { ok: true, empty: true };
  }
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  this._transcribe_worker(scope);
  return { ok: true };
};
P._load_whisper = async function () { return await loadWhisper((f) => bar(3 + Math.trunc(f * 6), `Загрузка модели ${Math.trunc(f * 100)}%…`)); };
P._transcribe_worker = async function (scope = 'video') {
  this.busy = true;
  try {
    const p = this._audio_path_for(scope);
    let audio; try { audio = await pcm16k(p); } catch (e) { audio = null; }
    if (!audio || audio.length < 1600) {
      log('  ℹ распознавание: пригодного аудио нет — пустой результат');
      if (scope === 'reel') this.reel_segments = []; else if (scope === 'foreign') this.foreign_segments = []; else this.segments = [];
      call_js('transcribeLoading', false); call_js('transcribeDone', 0, scope); return;
    }
    bar(3, 'Загрузка модели…'); call_js('transcribeLoading', true);
    log('▶ Загружаю модель whisper (small, int8)…');
    const asr = await this._load_whisper();
    call_js('transcribeLoading', false);
    log('✔ Модель загружена. Распознаю речь…'); bar(10, 'Распознавание…');
    const total = Math.max(1.0, audio.length / 16000);
    const tlang = scope === 'foreign' ? null : (scope === 'video' ? this.video_lang : 'ru');
    const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };
    if (tlang) opts.language = tlang === 'en' ? 'english' : 'russian';
    else {   // чужое видео — АВТО-ДЕТЕКТ языка исходника (как language=None в faster-whisper)
      const info = await detectLanguage(asr, audio);
      opts.language = info.language;
      log(`  🌐 язык исходника (авто-детект): ${info.language} (увер. ${Math.round(info.probability * 100)}%)`);
    }
    // «Моё видео — только субтитры»: пословные тайминги -> строки с точным таймингом
    const subs_mode = scope === 'foreign' && this.foreign_rewrite === 'subsonly';
    if (scope === 'foreign') this._foreign_lang = String(opts.language || '').toLowerCase();
    if (subs_mode) {
      const wout = await asr(audio, Object.assign({}, opts, { return_timestamps: 'word' }));
      const words = (wout.chunks || []).map(w => [w.text || '', Number((w.timestamp || [0])[0] || 0), Number((w.timestamp || [0, 0])[1] ?? (w.timestamp || [0])[0] ?? 0)]);
      const lines = this._regroup_words_to_lines(words);
      for (const ln of lines) log(`[${ln.start.toFixed(1).padStart(6)}s] ${ln.text}`);
      this.foreign_segments = lines;
      bar(100, 'Готово'); log(`✔ Распознано фраз: ${lines.length}`);
      call_js('transcribeDone', lines.length, scope);
      return;
    }
    const out = await asr(audio, opts);
    const result = [];
    for (const ch of (out.chunks || [])) {
      const [s, e] = ch.timestamp || [0, 0]; const text = (ch.text || '').trim(); if (!text) continue;
      result.push({ start: Number(s || 0), end: Number(e ?? s ?? 0), text });
      bar(10 + Math.min(88, Math.trunc((e || s || 0) / total * 88)), 'Распознавание…');
      log(`[${Number(s || 0).toFixed(1).padStart(6)}s] ${text}`);
    }
    if (scope === 'reel') this.reel_segments = result; else if (scope === 'foreign') this.foreign_segments = result; else this.segments = result;
    bar(100, 'Готово'); log(`✔ Распознано фраз: ${result.length}`);
    call_js('transcribeDone', result.length, scope);
  } catch (e) {
    log(`✖ Ошибка распознавания: ${e.message || e}`);
    call_js('transcribeLoading', false); call_js('transcribeDone', -1, scope, String(e.message || e).slice(0, 160));
  } finally { this.busy = false; }
};
// пословные тайминги -> строки субтитров (разрыв: конец предложения, пауза > gap, лимиты)
P._regroup_words_to_lines = function (words, max_words = 8, max_dur = 3.5, gap = 0.55) {
  const lines = []; let cur = [];
  for (const [w, s, e] of (words || [])) {
    if (!(w || '').trim()) continue;
    if (cur.length) {
      const start0 = cur[0][1], prev_end = cur[cur.length - 1][2], prev_w = (cur[cur.length - 1][0] || '').trim();
      const brk = cur.length >= max_words || (e - start0) > max_dur || (s - prev_end) > gap || /[.!?…]$/.test(prev_w);
      if (brk) { lines.push(cur); cur = []; }
    }
    cur.push([w.trim(), s, e]);
  }
  if (cur.length) lines.push(cur);
  const segs = [];
  for (const ln of lines) {
    const txt = clean_phrase(ln.map(x => x[0]).join(' ').replace(/\s+/g, ' ').trim());
    if (txt) segs.push({ start: Math.round(ln[0][1] * 100) / 100, end: Math.round(ln[ln.length - 1][2] * 100) / 100, text: txt });
  }
  return segs;
};
// Whisper word-level -> [(слово, start, end)]
P._transcribe_words = async function (p) {
  try {
    const audio = await pcm16k(p); if (!audio || audio.length < 1600) return [];
    const asr = await this._load_whisper();
    const klang = this.video_lang === 'en' ? 'english' : 'russian';
    const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: klang, task: 'transcribe' });
    return (out.chunks || []).map(w => [(w.text || '').trim(), Number((w.timestamp || [0])[0] || 0), Number((w.timestamp || [0, 0])[1] ?? (w.timestamp || [0])[0] ?? 0)]).filter(w => w[0]);
  } catch (e) {
    this._degrade('«Мой голос»: не удалось распознать тайминги слов — субтитры выровнены приблизительно и могут слегка расходиться с речью');
    log(`    (детали: ${e.message || e})`); return [];
  }
};
P._align_phrases = function (phrases, words, total) {
  const n = phrases.length;
  if (!words || !words.length) {
    const segs = []; let t = 0.0; const tot = phrases.reduce((a, p) => a + p.length, 0) || 1;
    for (const p of phrases) { const d = Math.max(0.4, total * p.length / tot); segs.push({ start: t, end: t + d, text: p }); t += d; }
    return segs;
  }
  const segs = []; let wi = 0; const W = words.length; let last = 0.0;
  phrases.forEach((ph, k) => {
    const wc = Math.max(1, ph.split(/\s+/).filter(Boolean).length); let start, end;
    if (wi < W) { start = words[wi][1]; const ei = Math.min(W - 1, wi + wc - 1); end = words[ei][2]; wi = ei + 1; }
    else { const rem = n - k; const chunk = Math.max(0.5, (total - last) / Math.max(1, rem)); start = last; end = last + chunk; }
    if (end <= start) end = start + 0.4;
    segs.push({ start: Math.max(start, last), end, text: ph }); last = end;
  });
  return segs;
};
function seqRatio(a, b) {   // difflib.SequenceMatcher(None,a,b).ratio() — 2*M/T по LCS-блокам
  if (!a.length && !b.length) return 1;
  const m = matchBlocks(a, b); return 2 * m / (a.length + b.length);
}
function matchBlocks(a, b) {
  // рекурсивный поиск самого длинного общего блока (как difflib)
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0; let j2len = {};
    for (let i = alo; i < ahi; i++) { const nj = {}; for (let j = blo; j < bhi; j++) { if (a[i] !== b[j]) continue; const k = (j2len[j - 1] || 0) + 1; nj[j] = k; if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; } } j2len = nj; }
    return [besti, bestj, bestsize];
  };
  let total = 0; const q = [[0, a.length, 0, b.length]];
  while (q.length) { const [alo, ahi, blo, bhi] = q.pop(); const [i, j, k] = longest(alo, ahi, blo, bhi); if (k) { total += k; if (alo < i && blo < j) q.push([alo, i, blo, j]); if (i + k < ahi && j + k < bhi) q.push([i + k, ahi, j + k, bhi]); } }
  return total;
}
P._align_myvoice = function (phrases, words, total) {
  const _nrm = (w) => (w || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-яё]/g, '');
  const ww = []; for (const w of (words || [])) if (w.length >= 3) { const n = _nrm(w[0]); if (n) ww.push([n, Number(w[1]), Number(w[2])]); }
  if (!ww.length) return this._align_phrases(phrases, words, total);
  const W = ww.length;
  const _match = (target, j) => { for (let d = 0; d < Math.min(6, W - j); d++) { const cand = ww[j + d][0]; if (cand === target || (target.length > 3 && cand.length > 3 && seqRatio(cand, target) >= 0.8)) return j + d; } return -1; };
  const segs = []; let wi = 0, last = 0.0;
  for (const ph of phrases) {
    const sw = ph.split(/\s+/).map(_nrm).filter(Boolean); let start_wi = wi, j = wi, matched_end = null;
    for (const target of sw) { const f = _match(target, j); if (f >= 0) { if (matched_end === null) start_wi = f; j = f + 1; matched_end = ww[f][2]; } }
    let st, en;
    if (matched_end === null) { const ei = Math.min(W - 1, wi + Math.max(1, sw.length) - 1); st = wi < W ? ww[wi][1] : last; en = ei < W ? ww[ei][2] : total; wi = ei + 1; }
    else { st = ww[start_wi][1]; en = matched_end; wi = j; }
    st = Math.max(st, last); en = Math.max(en, st + 0.3);
    segs.push({ start: Math.round(st * 1000) / 1000, end: Math.round(en * 1000) / 1000, text: ph }); last = en;
  }
  for (let i = 1; i < segs.length; i++) { if (segs[i].start < segs[i - 1].end) segs[i].start = segs[i - 1].end; if (segs[i].end < segs[i].start + 0.2) segs[i].end = segs[i].start + 0.2; }
  return segs;
};
