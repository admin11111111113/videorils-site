// Порт Api: подготовка текста к озвучке, ударения, ElevenLabs, цензура-бип, ручные
// ударения, _synth_one (Edge/Piper/Eleven + лимит Edge), Piper-мост (app.py 5730–6546).
import { C, log, re, pystrip, sleep, now, vfs, path, call_js, requests, TEMP_DIR } from './core.js';
import * as A from './audio.js';
import * as Piper from './piper.js';
import { edgeSynthesize, NoAudioReceived } from './edge_tts.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const EL_BASE = C['Api.EL_BASE'];
const { EMOTIONS } = C;
const ACUTE = '́';

// ---- троттлинг Edge (глобально, как _EDGE_* в app.py) ----
const EDGE = { LAST: 0, INTERVAL: C._EDGE_MIN_INTERVAL, OK: 0 };
let _edgeChain = Promise.resolve();
function _edge_throttle() {
  const p = _edgeChain.then(async () => { const w = EDGE.INTERVAL - (now() - EDGE.LAST); if (w > 0) await sleep(w); EDGE.LAST = now(); });
  _edgeChain = p.catch(() => { }); return p;
}
function _edge_limit_hit() { EDGE.INTERVAL = Math.min(C._EDGE_MAX_INTERVAL, EDGE.INTERVAL * 1.5); EDGE.OK = 0; }
function _edge_ok() { EDGE.OK++; if (EDGE.OK >= 5 && EDGE.INTERVAL > C._EDGE_MIN_INTERVAL) { EDGE.INTERVAL = Math.max(C._EDGE_MIN_INTERVAL, EDGE.INTERVAL / 1.5); EDGE.OK = 0; } }

export class _RevoiceAll extends Error { constructor(voice = '', engine = 'piper') { super(voice); this.voice = voice; this.engine = engine; this.name = '_RevoiceAll'; } }

Api._norm_stress = function (text) { if (!text) return text; return re.sub('\\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])', '\\1' + ACUTE, text); };
Api._strip_stress = function (text) { if (!text) return text; return re.sub('\\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])', '\\1', text).replaceAll(ACUTE, ''); };
P._norm_stress = Api._norm_stress; P._strip_stress = Api._strip_stress;
P._keep_homograph_stress = function (text) {
  if (!text) return text;
  text = re.sub('\\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])', '\\1' + ACUTE, text);
  return re.split('(\\s+)', text).map(tok => {
    if (!tok.includes(ACUTE)) return tok;
    const base = tok.replaceAll(ACUTE, ''); const baselow = base.replace(/[^а-яёА-ЯЁ]/g, '').toLowerCase();
    return C['Api._HOMOGRAPHS'].has(baselow) ? tok : base;
  }).join('');
};
Api._sanitize_tts = function (text) {
  if (!text) return text;
  let t = text.replace(/[​-‏‪-‮﻿]/g, '');
  t = [...t].filter(ch => ch >= ' ' || '\n\t'.includes(ch)).join('');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '');
  t = re.sub('\\*+(\\S(?:.*?\\S)?)\\*+', '\\1', t).replaceAll('*', '');
  return t.replace(/[ \t]+/g, ' ').trim();
};
P._sanitize_tts = Api._sanitize_tts;
P._fix_foreign_words = function (text) {
  if (!text) return text;
  const keys = Object.keys(this._TTS_FIX); if (!keys.length) return text;
  const pat = '\\b(?:' + keys.map(k => re.escape(k)).join('|') + ')\\b';
  return re.sub(pat, (m) => { const w = m.group(0); const fixed = this._TTS_FIX[w.toLowerCase()]; if (fixed === undefined) return w; return /\p{Lu}/u.test(w[0]) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed; }, text, 'i');
};
P._prewarm_pron = async function (phrases) {
  if (!this.el_pronounce || !(this.claude_key || this.gemini_key)) return;
  const todo = [], seen = new Set();
  for (const p of phrases) { const r = (p || '').trim(); if (r && !(r in this._pron_cache) && !seen.has(r)) { seen.add(r); todo.push(r); } }
  if (todo.length < 2) return;
  const numbered = todo.map((t, i) => `${i + 1}. ${t}`).join('\n');
  let ok, out; try { [ok, out] = await this._ai_call(C['Api._PRON_PROMPT_MULTI'] + numbered, null, Math.min(4000, 120 * todo.length + 200)); } catch (e) { return; }
  if (!ok || !out) return;
  const got = {};
  for (const ln of out.split('\n')) { const m = re.match('\\s*(\\d+)[.)]\\s*(.+)$', ln); if (m) got[parseInt(m.group(1)) - 1] = pystrip(pystrip(Api._clean_ai_text(m.group(2))), '"«»'); }
  if (Object.keys(got).length < todo.length) { log(`  ⚠ пакетная разметка ударений неполная (${Object.keys(got).length}/${todo.length}) — посценовый путь`); return; }
  let n = 0; todo.forEach((raw, i) => { const marked = got[i] || ''; if (marked && marked.length < raw.length * 3) { this._pron_cache[raw] = marked; n++; } });
  log(`  🎯 ударения размечены ОДНИМ запросом на ${n} фраз (вместо ${n} посценовых вызовов Gemini)`);
};
P._prepare_tts_text = async function (text) {
  const raw = this._fix_foreign_words((text || '').trim());
  if (!raw || !this.el_pronounce) return raw;
  if (!(this.claude_key || this.gemini_key)) return raw;
  if (raw in this._pron_cache) return this._pron_cache[raw];
  try {
    const [ok, out] = await this._ai_call(C['Api._PRON_PROMPT'] + raw, null, 700);
    if (ok && out && out.trim()) { const marked = pystrip(pystrip(Api._clean_ai_text(out)), '"«»'); if (marked && marked.length < raw.length * 3) { this._pron_cache[raw] = marked; return marked; } }
  } catch (e) { log(`  ⚠ разметка произношения не удалась (${e.message || e}) — сырой текст`); }
  return raw;
};
Api._letters_only = function (text) { return [...(text || '')].filter(ch => /\p{L}/u.test(ch)).map(c => c.toLowerCase()).join(''); };
P._letters_only = Api._letters_only;
P._scene_homographs = function (text) {
  const found = new Set();
  for (const w of re.findall('[а-яёА-ЯЁ́]+', text || '')) { const base = w.toLowerCase().replaceAll(ACUTE, ''); if (C['Api._HOMOGRAPHS'].has(base)) found.add(base); }
  return [...found].sort();
};
P._mark_stress = async function (text, ai = true) {
  const raw = (text || '').trim();
  if (!raw) return raw;
  if (raw in this._stress_cache) return this._stress_cache[raw];
  let base = this._fix_foreign_words(raw);
  const has_ai = ai && !!(this.claude_key || this.gemini_key);
  if (raw.includes(ACUTE) || !has_ai) { base = this._ensure_all_stressed(base); this._stress_cache[raw] = base; return base; }
  const want = Api._letters_only(raw);
  try {
    const prompt = 'Расставь ударения в русском тексте: после КАЖДОЙ ударной гласной добавь символ U+0301 (combining acute accent) — порядок «гласная, затем U+0301». ОБЯЗАТЕЛЬНО поставь ударение на КАЖДОМ слове, где 2 и более гласных — не пропускай ни одного многосложного слова. Слова с одной гласной (в, я, на, и, что) — без ударения. Верни ТОТ ЖЕ текст без иных изменений: те же слова, знаки, регистр и порядок — только добавь ударения. Без пояснений и кавычек.\n\nТекст: ' + raw;
    const [ok, out] = await this._ai_call(prompt, null, 700);
    if (ok && out && out.trim()) {
      let marked = pystrip(pystrip(Api._clean_ai_text(out)), '"«»');
      if (marked && Api._letters_only(marked) === want) { marked = this._ensure_all_stressed(marked); this._stress_cache[raw] = marked; return marked; }
    }
  } catch (e) { log(`  ⚠ разметка ударений не удалась (${e.message || e}) — словарь`); }
  base = this._ensure_all_stressed(base); this._stress_cache[raw] = base; return base;
};
P._mark_stress_all = async function (texts) {
  const res = {}, todo = [], seen = new Set();
  for (const t of texts) {
    const r = (t || '').trim(); if (!r || r in res) continue;
    if (r in this._stress_cache) res[r] = this._stress_cache[r];
    else if (r.includes(ACUTE) || !(this.claude_key || this.gemini_key)) res[r] = await this._mark_stress(r);
    else if (!seen.has(r)) { seen.add(r); todo.push(r); }
  }
  if (!todo.length) return res;
  if (todo.length === 1) { res[todo[0]] = await this._mark_stress(todo[0]); return res; }
  const numbered = todo.map((t, i) => `${i + 1}. ${t}`).join('\n'); const got = {};
  try {
    const prompt = 'Расставь ударения в каждом ПРОНУМЕРОВАННОМ русском тексте: после КАЖДОЙ ударной гласной добавь символ U+0301 (combining acute). Ударение на КАЖДОМ многосложном слове; слова с одной гласной — без. НЕ меняй слова, знаки, регистр, порядок — только добавь ударения. Верни РОВНО столько же строк «номер. тот же текст с ударениями», без пояснений.\n\n' + numbered;
    const [ok, out] = await this._ai_call(prompt, null, Math.min(4000, 160 * todo.length + 200));
    if (ok && out) for (const ln of out.split('\n')) { const m = re.match('\\s*(\\d+)[.)]\\s*(.+)$', ln); if (m) got[parseInt(m.group(1)) - 1] = pystrip(pystrip(Api._clean_ai_text(m.group(2))), '"«»'); }
  } catch (e) { log(`  ⚠ пакетная разметка ударений не удалась (${e.message || e}) — по одной`); }
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i]; let marked = got[i] || '';
    if (marked && Api._letters_only(marked) === Api._letters_only(r)) { marked = this._ensure_all_stressed(marked); this._stress_cache[r] = marked; res[r] = marked; }
    else res[r] = await this._mark_stress(r, false);
  }
  return res;
};
P._ensure_all_stressed = function (text) {
  const VOW = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';
  return re.sub('[А-Яа-яЁё́]+', (m) => {
    const w = m.group(0); if (w.includes(ACUTE)) return w;
    const vpos = []; [...w].forEach((c, i) => { if (VOW.includes(c)) vpos.push(i); });
    if (vpos.length < 2) return w;
    const p = vpos[vpos.length - 2]; const arr = [...w]; arr.splice(p + 1, 0, ACUTE); return arr.join('');
  }, text);
};
P.set_el_pronounce = function (on) { this.el_pronounce = !!on; this._persist(); return { ok: true, on: this.el_pronounce }; };

P._eleven_tts = async function (text, out, emotion = null, mark = true) {
  if (!(this.eleven_key && this.eleven_voice)) throw new Error(this._t('voice_key_missing'));
  if (mark) text = await this._prepare_tts_text(text);
  const url = `${EL_BASE}/text-to-speech/${this.eleven_voice}`;
  const em = EMOTIONS[emotion || this.reel_emotion] || EMOTIONS.energetic;
  const stab = Math.max(0.5, Math.min(0.7, Number(em.stability))), styl = Math.max(0.0, Math.min(0.35, Number(em.style)));
  const body = { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: stab, similarity_boost: 0.8, style: styl, use_speaker_boost: true } };
  const keys_n = Math.max(1, this.eleven_keys.length); const start = this.eleven_keys.length ? this.eleven_idx % keys_n : 0;
  for (let off = 0; off < keys_n; off++) {
    if (this.eleven_keys.length) this.eleven_idx = (start + off) % keys_n;
    const r = await requests.post(url, { headers: this._el_headers('audio/mpeg'), json: body, timeout: 90 });
    if (r.status_code === 200) { vfs.write(out, r.blob('audio/mpeg')); return; }
    if (r.status_code === 401 || r.status_code === 429) {
      if (off < keys_n - 1) { log(`  ↩ ElevenLabs ключ #${this.eleven_idx + 1}/${keys_n} исчерпан (HTTP ${r.status_code}) — пробую следующий`); continue; }
      throw new Error(this._t('voice_key_exhausted'));
    }
    throw new Error(`Voice Key ${r.status_code}: ${(r.text || '').slice(0, 120)}`);
  }
};
P._expand_units_for_speech = function (text) {
  if (!text) return text;
  let out = text;
  for (const [pat, rep] of C['Api._UNIT_SPEECH']) out = re.sub(pat, () => rep, out);
  out = re.sub('(?<=\\d)\\s*/\\s*(?=\\d)', ' на ', out);
  out = re.sub('\\s*/\\s*', ' ', out);
  return out;
};
P._latin_for_speech = function (text) {
  if (!text || !/[A-Za-z]/.test(text)) return text;
  const LS = C['Api._LATIN_SPEECH'], LL = C['Api._LAT_LETTER'];
  return re.sub('[A-Za-z0-9]*[A-Za-z][A-Za-z0-9\\-]*', (m) => {
    const tok = m.group(0); const low = tok.toLowerCase();
    if (low in LS) return LS[low];
    const core = tok.replace(/[^A-Za-z]/g, '');
    const isup = /[A-Z]/.test(tok) && !/[a-z]/.test(tok);
    if (isup && /^[A-Za-z]+$/.test(core) && core.length >= 1 && core.length <= 5) return [...core.toLowerCase()].map(c => LL[c] ?? c).join('-');
    return tok;
  }, text);
};

// ---- аудио-утилиты для склейки (замена ffmpeg -af silenceremove/areverse/concat) ----
function trimSilence(buf, thrDb = -50, minDur = 0.015, fromStart = true) {
  const thr = Math.pow(10, thrDb / 20); const d = buf.getChannelData(0); const sr = buf.sampleRate; const need = Math.max(1, Math.round(minDur * sr));
  if (fromStart) { let i = 0, run = 0; for (; i < d.length; i++) { if (Math.abs(d[i]) > thr) { run++; if (run >= need) { i -= need - 1; break; } } else run = 0; } return A.slice(buf, Math.max(0, i) / sr, buf.duration); }
  let i = d.length - 1, run = 0; for (; i >= 0; i--) { if (Math.abs(d[i]) > thr) { run++; if (run >= need) { i += need - 1; break; } } else run = 0; } return A.slice(buf, 0, Math.min(d.length, i + 1) / sr);
}
function gain(buf, g) { for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; } return buf; }
function beep(dur, vol, sr = 24000, fadeIn = 0.008, fadeOut = 0.02) {
  const b = new AudioBuffer({ length: Math.round(dur * sr), numberOfChannels: 1, sampleRate: sr }); const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) { const t = i / sr; let a = vol; if (fadeIn && t < fadeIn) a *= t / fadeIn; if (fadeOut && t > dur - fadeOut) a *= Math.max(0, (dur - t) / fadeOut); d[i] = a * Math.sin(2 * Math.PI * 1000 * t); }
  return b;
}

P._synth_censored = async function (text, out, emotion = null, mark = true, label = '', keep_stress = false) {
  const parts = []; let last = 0, carry = '';
  const rx = new RegExp(C._CENSOR_RE.source, C._CENSOR_RE.flags.includes('g') ? C._CENSOR_RE.flags : C._CENSOR_RE.flags + 'g');
  for (const mm of text.matchAll(rx)) { const w = mm[0]; parts.push(['s', carry + text.slice(last, mm.index) + w.slice(0, 2)]); parts.push(['b', 'е']); carry = w.slice(3); last = mm.index + w.length; }
  parts.push(['s', carry + text.slice(last)]);
  const base = path.splitext(path.basename(out))[0]; const segs = [];
  for (let i = 0; i < parts.length; i++) {
    const [kind, val] = parts[i];
    if (kind === 's') {
      const sv = pystrip(val || '', ' ,.;:—–\t'); if (!sv) continue;
      const mp3 = `temp/cens_${base}_${i}.mp3`;
      try { await this._synth_one(sv, mp3, { emotion, mark, label, keep_stress }); } catch (e) { continue; }
      if (!(vfs.exists(mp3) && vfs.size(mp3) > 200)) continue;
      let b = await A.resample(await A.decode(mp3), 24000, 1);
      if (i > 0 && parts[i - 1][0] === 'b') b = trimSilence(b, -50, 0.015, true);
      if (i < parts.length - 1 && parts[i + 1][0] === 'b') b = trimSilence(b, -50, 0.015, false);
      segs.push(gain(b, 1.18));
    } else segs.push(beep(0.20, 0.42));
  }
  if (!segs.length) { vfs.write(out, A.wav(beep(0.45, 0.45, 24000, 0, 0))); return; }
  vfs.write(out, A.wav(A.concat(segs, 24000, 1)));
};
Api._is_mixed_stress = function (text) {
  const words = re.findall('[А-Яа-яЁё́]+', text || '');
  const has_acc = words.some(w => w.includes(ACUTE));
  const has_clean_multi = words.some(w => !w.includes(ACUTE) && [...w.toLowerCase()].filter(c => 'аеёиоуыэюя'.includes(c)).length >= 2);
  return has_acc && has_clean_multi;
};
P._is_mixed_stress = Api._is_mixed_stress;
P._has_brand_stress = function (text) {
  const words = re.findall('[А-Яа-яЁё́]+', text || '');
  const has_brand = words.some(w => w.includes(ACUTE) && C['Api._BRAND_KEYS'].has(w.replaceAll(ACUTE, '').toLowerCase()));
  const has_clean_multi = words.some(w => !w.includes(ACUTE) && [...w.toLowerCase()].filter(c => 'аеёиоуыэюя'.includes(c)).length >= 2);
  return has_brand && has_clean_multi;
};
P._synth_manual_stress = async function (text, out, emotion = null, mark = true, label = '') {
  const segs = []; let buf = '', pos = 0;
  for (const mo of (text || '').matchAll(/[А-Яа-яЁё́]+/g)) {
    let w = mo[0]; buf += text.slice(pos, mo.index); pos = mo.index + w.length;
    if (w.includes(ACUTE)) { if (buf.trim()) { segs.push(['clean', buf]); buf = ''; } else { w = buf + w; buf = ''; } segs.push(['acc', w]); }
    else buf += w;
  }
  buf += text.slice(pos); if (buf.trim()) segs.push(['clean', buf]);
  const base = path.splitext(path.basename(out))[0]; const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const [kind, val] = segs[i]; const mp3 = `temp/ms_${base}_${i}.mp3`;
    try { await this._synth_one(val, mp3, { emotion, mark, label, keep_stress: kind === 'acc' }); } catch (e) { continue; }
    if (!(vfs.exists(mp3) && vfs.size(mp3) > 200)) continue;
    let b = await A.resample(await A.decode(mp3), 24000, 1);
    if (i > 0) b = trimSilence(b, -50, 0.02, true);
    if (i < segs.length - 1) b = trimSilence(b, -50, 0.02, false);
    parts.push(b);
  }
  if (!parts.length) return await this._synth_one(Api._strip_stress(text || ''), out, { emotion, mark, label });
  vfs.write(out, A.wav(parts.length === 1 ? parts[0] : A.concat(parts, 24000, 1)));
};

// Совместимость сигнатуры: _synth_one(text, out, emotion|{opts}, mark, label, keep_stress)
P._synth_one = async function (text, out, emotion = null, mark = true, label = '', keep_stress = false) {
  if (emotion && typeof emotion === 'object') { const o = emotion; emotion = o.emotion ?? null; mark = o.mark ?? true; label = o.label ?? ''; keep_stress = !!o.keep_stress; }
  if (re.search(C._CENSOR_RE, text || '')) return await this._synth_censored(text, out, emotion, mark, label, keep_stress);
  if (keep_stress && Api._is_mixed_stress(text || '')) return await this._synth_manual_stress(text, out, emotion, mark, label);
  let use_eleven = ((this.tts_engine === 'eleven' || this._build_eleven_override) && !this._force_edge && this.eleven_key && this.eleven_voice && this.licensed);
  let pre = keep_stress ? text : Api._strip_stress(text);
  pre = this._expand_units_for_speech(pre);
  pre = this._fix_foreign_words(pre);
  if (this.video_lang !== 'en') pre = this._latin_for_speech(pre);
  const clean = Api._sanitize_tts(pre);
  if (use_eleven) {
    try { await this._eleven_tts(clean, out, emotion, false); }
    catch (_e) {
      log(`  ⚠ платный голос не ответил (${String(_e.message || _e).slice(0, 70)}) — перехожу на Edge`);
      this._force_edge = true;
      this._degrade('Платный голос не сработал — ролик озвучен бесплатным голосом Edge (проверь ключ и выбранный голос)');
      if (this._in_phrase_loop) throw new _RevoiceAll('', 'edge');
      use_eleven = false;
    }
  }
  if (use_eleven) return;
  if ((this.tts_engine === 'piper' && !this._force_edge) || this._build_piper_override) {
    await this._piper_tts(clean, out, this._build_piper_override || null);
    return;
  }
  const em = EMOTIONS[emotion || 'calm'] || EMOTIONS.calm;
  const rate_v = Math.max(-40, Math.min(40, this.reel_rate + (em.edge_rate || 0)));
  const pitch_v = Math.max(-30, Math.min(30, this.reel_pitch + (em.edge_pitch || 0)));
  const sgn = (v) => (v >= 0 ? '+' : '') + Math.trunc(v);
  const rate = `${sgn(rate_v)}%`, pitch = `${sgn(pitch_v)}Hz`;
  const voice = this._active_edge_voice();
  const tag = label || path.basename(out);
  const _EDGE_STEP = 25, _EDGE_CAP = 300, _EDGE_ASK_AFTER = 50;
  let edge_waited = 0;
  while (true) {
    let got = false;
    // прослушивание: Microsoft отказывает ~каждому 5-му запросу вне зависимости от IP, повтор через
    // мгновение обычно проходит — поэтому 6 БЫСТРЫХ попыток (0.4с), без роста общей паузы; сборка — как раньше
    const PREV = !!this._tts_preview, N = PREV ? 6 : 4;
    for (let attempt = 0; attempt < N; attempt++) {
      if (!PREV) await _edge_throttle();
      vfs.remove(out);
      try {
        const r = await edgeSynthesize(clean, voice, { rate, pitch });
        if (r.audio && r.audio.size > 0) {
          vfs.write(out, r.audio); this._last_edge_words = r.words;
          log(`  🔊 Edge-TTS ${tag} попытка ${attempt + 1}: успех`); got = true; _edge_ok(); break;
        }
        throw new NoAudioReceived();
      } catch (e) {
        const empty = (String(e.message || '').toLowerCase().includes('no audio') || e.name === 'NoAudioReceived');
        if (empty && !PREV) _edge_limit_hit();
        // «ошибка соединения» (не лимит) — повтор через 1с; долгие паузы 2/4/8с — только для «пусто» (лимит)
        const back = PREV ? 0.4 : (empty ? 2 ** (attempt + 1) : 1);
        log(`  ⚠ Edge-TTS ${tag} попытка ${attempt + 1}/${N}: ` + (empty ? 'пусто (лимит частоты Microsoft)' : String(e.message || e).slice(0, 60)) + (attempt < N - 1 ? ` — пауза ${back}с` : ' — жду лимит'));
        if (attempt < N - 1) await sleep(back);
      }
    }
    if (got) return;
    // прослушивание — без долгого ожидания лимита: 4 быстрые попытки и сразу сообщение
    if (this._tts_preview) throw new Error('Microsoft сейчас ограничивает озвучку — попробуй через минуту или выбери голос Piper');
    const choice = this._edge_build_choice ?? null;
    if (choice === null && edge_waited >= _EDGE_ASK_AFTER) {
      const piper_ok = this.video_lang !== 'en';
      const eleven_ok = !!(this.eleven_key && this.eleven_voice && this.licensed);
      const ans = await this._ask_edge_choice(tag, piper_ok, eleven_ok);
      const act = (ans || {}).action;
      if (act === 'piper' && piper_ok) {
        this._edge_build_choice = 'piper';
        this._build_piper_override = ans.voice || this.piper_voice || 'irina';
        log('  🔀 Лимит Edge: переключаюсь на офлайн-голос Piper до конца сборки');
        if (this._in_phrase_loop) throw new _RevoiceAll(this._build_piper_override);
        await this._piper_tts(clean, out, this._build_piper_override); return;
      }
      if (act === 'eleven' && eleven_ok) {
        this._edge_build_choice = 'eleven'; this._build_eleven_override = true;
        log('  🔀 Лимит Edge: переключаюсь на ElevenLabs до конца сборки');
        await this._eleven_tts(clean, out, emotion, false); return;
      }
      if (act === 'cancel') throw new Error(this._t('edge_wait_giveup'));
      this._edge_build_choice = 'wait';
    }
    edge_waited += _EDGE_STEP;
    if (edge_waited > _EDGE_CAP) { log(`  ✖ Edge-TTS ${tag}: лимит Microsoft держится >${_EDGE_CAP}с — сдаюсь`); throw new Error(this._t('edge_wait_giveup')); }
    call_js('edgeLimitWait', { waited: edge_waited, cap: _EDGE_CAP });
    log(`  ⏳ Ждём Edge-TTS (лимит Microsoft) — пауза ${_EDGE_STEP}с (${edge_waited}/${_EDGE_CAP}с)`);
    await sleep(_EDGE_STEP);
  }
};
P._ask_edge_choice = async function (tag = '', piper_ok = true, eleven_ok = false) {
  await Piper.refreshStored();
  this._edge_choice = null;
  const p = new Promise(res => { this._edge_choice_resolve = res; setTimeout(() => res(null), 900000); });
  call_js('edgeLimitAsk', { voices: Piper.voices_status(), current: this.piper_voice || 'irina', piper_ok: !!piper_ok, eleven_ok: !!eleven_ok });
  log(`  ⏸ ${tag}: Edge-TTS лимит — жду выбор пользователя…`);
  await p;
  return this._edge_choice || { action: 'cancel' };
};
P.resolve_edge_choice = function (action, voice = '', seconds = 20) {
  this._edge_choice = { action, voice, seconds };
  if (this._edge_choice_resolve) { this._edge_choice_resolve(true); this._edge_choice_resolve = null; }
  return { ok: true };
};
P._piper_tts = async function (text, out, voice_override = null) {
  let voice = voice_override || this.piper_voice || Piper.DEFAULT_VOICE;
  if (!Piper.VOICE_SET.has(voice)) voice = Piper.DEFAULT_VOICE;
  await Piper.refreshStored();
  if (!Piper.is_downloaded(voice)) { log(`  ⬇ Piper: качаю модель голоса «${voice}» (~63МБ, разово)…`); await Piper.download_voice(voice); log(`  ✓ Piper: модель «${voice}» готова`); }
  const spd = this.piper_speed || 0; const ls = Math.max(0.5, Math.min(1.6, 1.0 - spd / 100.0));
  const wav = await Piper.synth_wav(text || '', voice, ls);
  if (!wav || !wav.size) throw new Error(this._t('piper_convert_fail'));
  vfs.write(out, wav);
};
P.piper_voices = async function () { await Piper.refreshStored(); return { voices: Piper.voices_status(), current: this.piper_voice || Piper.DEFAULT_VOICE, speed: this.piper_speed || 0 }; };
P.set_piper_voice = function (voice) { this.piper_voice = Piper.VOICE_SET.has(voice) ? voice : Piper.DEFAULT_VOICE; this._persist(); return { ok: true, voice: this.piper_voice }; };
P.set_piper_speed = function (pct) { const v = parseInt(pct); this.piper_speed = Number.isNaN(v) ? 0 : Math.max(-40, Math.min(40, v)); this._persist(); return { ok: true, speed: this.piper_speed }; };
P.piper_download = async function (voice) {
  const v = Piper.VOICE_SET.has(voice) ? voice : Piper.DEFAULT_VOICE;
  try { await Piper.download_voice(v, (p) => call_js('piperProgress', p)); return { ok: true, voice: v }; }
  catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 120) }; }
};
