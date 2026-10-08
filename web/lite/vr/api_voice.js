// Порт Api: «Мой голос», ключи (eleven/pexels/claude/gemini getters), онбординг,
// ElevenLabs (кредиты, голоса, демо), get_voice_engine (app.py 5125–5648).
import { C, log, re, requests, webbrowser, vfs, pickFiles, b64ToBlob, TEMP_DIR, path } from './core.js';
import * as A from './audio.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const EL_BASE = C['Api.EL_BASE'], EL_MIN_CHARS = C['Api.EL_MIN_CHARS'];

P.save_myvoice_audio = async function (b64, ext = 'webm') {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  try {
    const src = b64ToBlob(b64);
    vfs.write('temp/myvoice_raw.' + (ext || 'webm'), src);
    const dst = 'temp/myvoice.wav';
    vfs.write(dst, await A.toWav(src, 44100, 1));
    this.myvoice_path = dst; this.myvoice_segments = [];
    return { ok: true, dur: Math.round((await A.duration(dst)) * 10) / 10 };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.clear_myvoice = function () { const p = this.myvoice_path; this.myvoice_path = ''; this.myvoice_segments = []; if (p) vfs.remove(p); return { ok: true }; };
P.choose_myvoice_file = function () {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  const pick = pickFiles('audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm');   // синхронно из клика
  return pick.then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    try {
      const dst = 'temp/myvoice.wav';
      vfs.write(dst, await A.toWav(files[0], 44100, 1));
      this.myvoice_path = dst; this.myvoice_segments = [];
      return { ok: true, name: files[0].name, dur: Math.round((await A.duration(dst)) * 10) / 10 };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  });
};
P.set_myvoice_segments = function (segs) {
  let out = [];
  try {
    for (const s of (segs || [])) {
      const st = parseFloat(s.start || 0) || 0; let en = parseFloat(s.end || 0) || 0; if (en < st) en = st;
      out.push({ start: Math.round(st * 1000) / 1000, end: Math.round(en * 1000) / 1000 });
    }
  } catch (e) { out = []; }
  this.myvoice_segments = out;
  return { ok: true, n: out.length };
};
P._karaoke_segments = function (phrases, kseg, words, total) {
  const ws = (words || []).filter(w => w.length >= 2).map(w => [Number(w[0]), Number(w[1])]);
  const segs = []; let last = 0.0, wi = 0;
  phrases.forEach((ph, i) => {
    const ntok = Math.max(1, re.findall('\\S+', ph || '').filter(t => re.search('\\w', t)).length);
    let st, en;
    if (ws.length && wi < ws.length) {
      const j = i === phrases.length - 1 ? ws.length : Math.min(ws.length, wi + ntok);
      st = ws[wi][0]; en = ws[j - 1][1]; wi = j;
    } else {
      st = i < kseg.length ? Number(kseg[i].start ?? last) : last;
      en = i < kseg.length ? Number(kseg[i].end ?? st) : (total || st + 1.0);
      if (ws.length) {
        let near = ws[0][0]; for (const w of ws) if (Math.abs(w[0] - st) < Math.abs(near - st)) near = w[0];
        if (Math.abs(near - st) <= 0.6) st = near;
      }
    }
    st = Math.max(st, last); en = Math.max(en, st + 0.3);
    if (total) { st = Math.min(st, total); en = Math.min(en, total); }
    segs.push({ start: Math.round(st * 1000) / 1000, end: Math.round(en * 1000) / 1000, text: ph });
    last = en;
  });
  return segs;
};
P.myvoice_splice_scene = async function (idx, b64, ext, seg_start, seg_end) {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  try {
    if (!(this.myvoice_path && vfs.exists(this.myvoice_path))) return { ok: false, msg: this._t('myvoice_no_recording') };
    seg_start = Math.max(0.0, parseFloat(seg_start || 0) || 0); seg_end = Math.max(seg_start, parseFloat(seg_end || 0) || 0);
    const nb = await A.resample(await A.decode(b64ToBlob(b64)), 44100, 1);
    const newdur = nb.duration;
    const whole = await A.resample(await A.decode(this.myvoice_path), 44100, 1);
    const total = whole.duration;
    const out = A.concat([A.slice(whole, 0, seg_start), nb, A.slice(whole, seg_end, total)], 44100, 1);
    vfs.write(this.myvoice_path, A.wav(out));
    const delta = newdur - (seg_end - seg_start);
    const segs = [...(this.myvoice_segments || [])];
    if (idx >= 0 && idx < segs.length) {
      const r3 = (v) => Math.round(v * 1000) / 1000;
      segs[idx] = { start: r3(seg_start), end: r3(seg_start + newdur) };
      for (let j = idx + 1; j < segs.length; j++) segs[j] = { start: r3(segs[j].start + delta), end: r3(segs[j].end + delta) };
      this.myvoice_segments = segs;
    }
    return { ok: true, dur: Math.round(out.duration * 10) / 10, segments: this.myvoice_segments };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 80) }; }
};
P.set_eleven_voice = function (voice_id) { this.eleven_voice = (voice_id || '').trim(); this._persist(); return this.eleven_voice; };
P._el_headers = function (accept = null, key = null) { const h = { 'xi-api-key': key !== null ? key : this.eleven_key }; if (accept) h.Accept = accept; return h; };
for (const [name, list, idx] of [['eleven_key', 'eleven_keys', 'eleven_idx'], ['pexels_key', 'pexels_keys', 'pexels_idx'], ['claude_key', 'claude_keys', 'claude_idx'], ['gemini_key', 'gemini_keys', 'gemini_idx']]) {
  Object.defineProperty(P, name, { get() { const l = this[list]; return l && l.length ? l[(this[idx] || 0) % l.length] : ''; }, configurable: true });
}
P.reveal_key = function (kind, idx = 0) {
  idx = parseInt(idx); if (Number.isNaN(idx)) idx = 0;
  let ks = [];
  if (kind === 'pixabay' || kind === 'px') ks = (this.pixabay_keys && this.pixabay_keys.length) ? this.pixabay_keys : (this.pixabay_key ? [this.pixabay_key] : []);
  else if (kind === 'eleven' || kind === 'el') ks = this.eleven_keys || [];
  else if (kind === 'pexels' || kind === 'px2') ks = this.pexels_keys || [];
  else if (kind === 'claude' || kind === 'ai') ks = this.claude_keys || [];
  else if (kind === 'gemini') ks = this.gemini_keys || [];
  const k = idx >= 0 && idx < ks.length ? ks[idx] : '';
  return { ok: !!k, key: k };
};
P.get_keys_status = function () { return { pixabay: !!this.pixabay_key, pexels: !!this.pexels_key, eleven: !!this.eleven_key, ai: !!this.claude_key, gemini: !!this.gemini_key, collapsed: this.keys_collapsed }; };
P.set_keys_collapsed = function (v) { this.keys_collapsed = !!v; this._persist(); return { ok: true, collapsed: this.keys_collapsed }; };
P.get_onboarding_state = function () { const has_media = !!(this.pixabay_key || this.pexels_key); return { show: !this.media_onboarded && !has_media }; };
P.set_media_onboarded = function (v = true) { this.media_onboarded = !!v; this._persist(); return { ok: true }; };
P.onboarding_check_key = async function (service, key) {
  key = (key || '').trim();
  if (!key) return { ok: false, empty: true };
  const svc = (service || '').toLowerCase();
  const is_pexels = svc.includes('pex') || svc === 'media1' || svc === '1';
  let ok = false;
  try { ok = !!(is_pexels ? await this._pexels_check(key) : await this._pixabay_check(key))[0]; } catch (e) { ok = false; }
  if (ok) { if (is_pexels) await this.set_pexels_key(key); else await this.set_pixabay_key(key); this.media_onboarded = true; this._persist(); }
  return { ok };
};
P._el_credits_for = async function (key) {
  if (!this._key_ascii_ok(key)) return { ok: false, msg: this._t('keyerr_bad') };
  try {
    const r = await requests.get(EL_BASE + '/user/subscription', { headers: { 'xi-api-key': key }, timeout: 8 });
    if (r.status_code === 401 || r.status_code === 403) return { ok: false, msg: this._t('keyerr_bad') };
    if (r.status_code !== 200) return { ok: false, msg: this._t('http_status', r.status_code) };
    const d = r.json(); const used = parseInt(d.character_count || 0) || 0, limit = parseInt(d.character_limit || 0) || 0;
    return { ok: true, used, limit, remaining: Math.max(0, limit - used) };
  } catch (e) {
    const m = String(e.message || e);
    if (m.startsWith('timeout')) return { ok: false, msg: this._t('keyerr_timeout') };
    if (m.startsWith('connection')) return { ok: false, msg: this._t('keyerr_net') };
    log(`  ⚠ ElevenLabs проверка ключа: ${m.slice(0, 120)}`);
    return { ok: false, msg: this._t('keyerr_bad') };
  }
};
P.get_eleven_credits = async function () { if (!this.eleven_key) return { ok: false }; return await this._el_credits_for(this.eleven_key); };
P._el_key_state = async function (key) {
  const c = await this._el_credits_for(key);
  if (!c.ok) return ['error', null];
  const rem = c.remaining;
  if (rem == null || rem < EL_MIN_CHARS) return ['spent', rem];
  return ['ok', rem];
};
P.get_eleven_key_status = async function () {
  if (!this.eleven_key) return { has: false };
  const [state, rem] = await this._el_key_state(this.eleven_key);
  return { has: true, mask: Api._mask(this.eleven_key), state, remaining: rem };
};
P._el_keys_view = function () { return this.eleven_keys.map(k => ({ mask: Api._mask(k) })); };
P.get_eleven_masks = function () { return { keys: this.eleven_keys.map(k => ({ mask: Api._mask(k), status: 'checking' })), max: 1 }; };
P.get_eleven_keys = async function () {
  const out = [];
  for (const k of this.eleven_keys) { const [state, rem] = await this._el_key_state(k); out.push({ mask: Api._mask(k), state, remaining: rem, ok: ['ok', 'low'].includes(state) }); }
  return { keys: out, max: 1 };
};
P.add_eleven_key = async function (key) {
  this.track('keys_saved');
  key = this._clean_key(key);
  if (!key) return { ok: false, msg: this._t('key_enter'), keys: this._el_keys_view() };
  if (this.eleven_keys.length >= 1) return { ok: false, msg: this._t('max_1_key'), keys: this._el_keys_view() };
  if (this.eleven_keys.includes(key)) return { ok: false, msg: this._t('key_already_added'), keys: this._el_keys_view() };
  this.eleven_keys.push(key); this._persist();
  const [state, rem] = await this._el_key_state(key);
  return { ok: true, has: true, mask: Api._mask(key), state, remaining: rem, keys: this._el_keys_view() };
};
P.remove_eleven_key = function (idx = 0) {
  const i = parseInt(idx); if (!Number.isNaN(i) && i >= 0 && i < this.eleven_keys.length) { this.eleven_keys.splice(i, 1); this.eleven_idx = 0; this._persist(); }
  return { ok: true, has: !!this.eleven_keys.length, keys: this._el_keys_view() };
};
P.set_eleven_key = function (key) { return this.add_eleven_key(key); };
P.open_eleven_subscription = function () { webbrowser.open('https://elevenlabs.io/subscription'); return true; };
P._voice_lang = function (v) {
  const labels = v.labels || {}, ft = v.fine_tuning || {};
  const lang = String(labels.language || ft.language || '').toLowerCase(), accent = String(labels.accent || '').toLowerCase(), desc = String(labels.description || '').toLowerCase();
  const blob = [lang, accent, desc, (v.name || '').toLowerCase()].join(' ');
  if (lang.startsWith('ru') || blob.includes('russ') || blob.includes('русск')) return [0, '🇷🇺 русский'];
  const models = v.high_quality_base_model_ids || [];
  if (models.some(m => m.includes('multilingual')) || blob.includes('multi')) return [1, '🌐 мультиязычный'];
  if (accent) return [2, accent];
  if (lang) return [2, lang];
  return [3, ''];
};
P.list_eleven_voices = async function () {
  if (!this.eleven_key) return { ok: false, msg: this._t('eleven_key_not_set'), voices: [] };
  try {
    const r = await requests.get(EL_BASE + '/voices', { headers: this._el_headers(), timeout: 25 });
    if (r.status_code !== 200) return { ok: false, msg: this._t('http_status', r.status_code), voices: [] };
    const raw = r.json().voices || [];
    const CUR = C['Api.EL_CURATED_RU'];
    let voices = []; const have = new Set(); const en = this.video_lang === 'en';
    for (const v of raw) {
      const vid = v.voice_id || '';
      if (this.el_dead_voices.has(vid)) continue;
      const g = (v.labels || {}).gender || 'other';
      if (!['female', 'male'].includes(g)) continue;
      const [pr, lab] = this._voice_lang(v);
      if (!en && pr === 2) continue;
      have.add(vid);
      voices.push({ name: v.name || '?', voice_id: vid, preview_url: v.preview_url || '', lang: lab, gender: g, _pr: pr });
    }
    const have_names = new Set(voices.map(v => v.name.toLowerCase()));
    for (const c of CUR) {
      if (this.el_dead_voices.has(c.voice_id)) continue;
      if (!have.has(c.voice_id) && !have_names.has(c.name.toLowerCase())) voices.push({ name: c.name + ' (рекоменд.)', voice_id: c.voice_id, preview_url: '', lang: '🌐 читает русский', gender: c.gender, _pr: 1 });
    }
    voices.sort((a, b) => (a._pr - b._pr) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    for (const v of voices) delete v._pr;
    const fem = voices.filter(v => v.gender === 'female'), mal = voices.filter(v => v.gender === 'male');
    const acct = new Set(voices.map(v => v.name.toLowerCase().split(' (')[0].trim()));
    const library = C['Api.EL_LIBRARY_RU'].filter(lv => !acct.has(lv.name.toLowerCase())).map(lv => ({ name: lv.name, voice_id: '', gender: lv.gender, desc: lv.desc, locked: true }));
    return { ok: true, voices: [...fem, ...mal], female: fem, male: mal, library };
  } catch (e) { return { ok: false, msg: String(e.message || e), voices: [] }; }
};
// демо кэшируется в IndexedDB-подобном кэше браузера (Cache API) — 1 раз на голос
P.eleven_voice_demo = async function (voice_id) {
  if (!voice_id) return { ok: false, msg: this._t('no_voice') };
  const en = this.video_lang === 'en'; const suffix = en ? '_en' : '';
  const demo_text = en ? 'Hi! This is how my voice sounds.' : 'Привет! Так звучит мой голос на русском языке.';
  const rel = `assets/voice_demos/${voice_id}${suffix}.mp3`;
  if (await vfs.restore(rel) && vfs.size(rel) > 0) return { ok: true, url: vfs.url(rel), cached: true };   // 0 кредитов
  if (!this.eleven_key) return { ok: false, msg: this._t('no_key') };
  try {
    const r = await requests.post(`${EL_BASE}/text-to-speech/${voice_id}`, { headers: this._el_headers('audio/mpeg'), json: { text: demo_text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }, timeout: 60 });
    const ctype = r.headers.get('Content-Type') || '';
    if (r.status_code !== 200 || !r.buf.byteLength || !ctype.includes('audio')) {
      this.el_dead_voices.add(voice_id); this._persist();
      return { ok: false, msg: this._t('voice_no_russian', r.status_code), dead: true };
    }
    vfs.write(rel, r.blob('audio/mpeg')); await vfs.flush(rel);
    return { ok: true, url: vfs.url(rel) };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.get_voice_engine = function () { return { engine: this.tts_engine, has_key: !!this.eleven_key, eleven_voice: this.eleven_voice, content_lang: this.video_lang, pronounce: this.el_pronounce }; };
