// Порт Api: reset/источник, свои файлы, split, заголовок, музыка-сбор, Media/Pexels-ключи,
// ссылки «получить ключ», Bybit (app.py 6547–7066).
import { C, log, re, requests, webbrowser, vfs, pickFiles, path, VR_SERVER_URL } from './core.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const MEDIA_IMG = C['Api.MEDIA_IMG'], MEDIA_VID = C['Api.MEDIA_VID'], AUDIO_EXTS = C['Api.AUDIO_EXTS'];

P.reset_reel = function () {
  this.reel_scenes = []; this.reel_caption = ''; this.reel_hashtags = ''; this.reel_topic = '';
  this.reel_scenario = 'auto'; this.reel_seconds = 30;
  try { this._reset_scene_media(true); } catch (e) { }
  this._persist();
  return { ok: true, seconds: this.reel_seconds, scenario: this.reel_scenario };
};
P.set_reel_source = function (mode) { this.reel_source = mode === 'foreign' ? 'foreign' : 'scratch'; return this.reel_source; };
P.switch_reel_source = function (mode) {
  mode = mode === 'foreign' ? 'foreign' : 'scratch';
  const old = this.reel_source;
  if (!this._src_stash) this._src_stash = {};
  if (mode === old) return { ok: true, scenes: this.get_scenes() };
  this._src_stash[old] = { scenes: this.reel_scenes.map(s => Object.assign({}, s)), phrases: [...this.reel_phrases], caption: this.reel_caption, hashtags: this.reel_hashtags, topic: this.reel_topic };
  const st = this._src_stash[mode] || {};
  this.reel_scenes = (st.scenes || []).map(s => Object.assign({}, s));
  this.reel_phrases = [...(st.phrases || [])];
  this.reel_caption = st.caption || ''; this.reel_hashtags = st.hashtags || ''; this.reel_topic = st.topic || '';
  this.reel_source = mode; this._persist();
  return { ok: true, scenes: this.get_scenes() };
};
P.get_foreign_info = function () {
  const full = this.foreign_segments.map(s => s.text.trim()).join(' ').trim();
  return { has: !!this.foreign_segments.length, count: this.foreign_segments.length, text: full, rewrite: this.foreign_rewrite };
};
P._is_video_file = function (p) { const l = String(p || '').toLowerCase(); return MEDIA_VID.some(e => l.endsWith(e)); };
P.set_split_top_video = function () {
  return pickFiles('video/*').then(files => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    const dst = 'input/split_top' + path.splitext(files[0].name)[1].toLowerCase();
    vfs.write(dst, files[0]); this.split_top_path = dst; this._persist();
    return { ok: true, name: files[0].name };
  });
};
P.get_split_top = function () { const p = this.split_top_path; return { has: !!(p && vfs.exists(p)), name: p ? path.basename(p) : '', order: this.split_order }; };
P.set_split_order = function (order) { this.split_order = order === 'video_bottom' ? 'video_bottom' : 'video_top'; this._persist(); return { ok: true, order: this.split_order }; };
P.set_title_text = function (text) { this.title_text = (text || '').trim(); this._persist(); return { ok: true }; };
P.set_title_xy = function (x, y) {
  const a = parseFloat(x), b = parseFloat(y);
  if (!Number.isNaN(a) && !Number.isNaN(b)) { this.title_xpct = Math.max(0, Math.min(1, a)); this.title_ypct = Math.max(0, Math.min(1, b)); this._persist(); }
  return { xpct: this.title_xpct, ypct: this.title_ypct };
};
P.set_title_fontsize = function (pct) { const v = parseFloat(pct); if (!Number.isNaN(v)) { this.title_fontpct = Math.max(0.025, Math.min(0.12, v)); this._persist(); } return { fontpct: this.title_fontpct }; };
P.set_title_theme = function (key) { if (key in C.TITLE_THEMES) { this.title_theme = key; this._persist(); } return { theme: this.title_theme }; };
P.set_title_on = function (on) { this.title_on = !!on; this._persist(); return { title_on: this.title_on }; };
P.get_title = function () { return { text: this.title_text, xpct: this.title_xpct, ypct: this.title_ypct, fontpct: this.title_fontpct, theme: this.title_theme, title_on: this.title_on }; };

// ---------------- музыка: треки пользователя живут в assets/user/music/ (Cache Storage) ----
P._collect_tracks = function () {
  const hidden = new Set(this.music_hidden || []);
  return vfs.list('assets/user/music/').filter(p => AUDIO_EXTS.some(e => p.toLowerCase().endsWith(e))).sort().filter(p => !hidden.has(p.toLowerCase()));
};
P.has_music = function () { return this._collect_tracks().length > 0; };

// ---------------- Media Key ----------------
Api._clean_key = function (key) {
  let s = (key || '').trim();
  while (s.length >= 2 && "\"'`«".includes(s[0]) && "\"'`»".includes(s[s.length - 1])) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, '');
};
P._clean_key = Api._clean_key;
Api._key_ascii_ok = function (key) { const s = (key || '').trim(); if (!s) return false; return [...s].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127); };
P._key_ascii_ok = Api._key_ascii_ok;
function netState(e) { const m = String(e && e.message || e); return m.startsWith('timeout') ? 'timeout' : (m.startsWith('connection') ? 'network' : 'bad_key'); }

P._pixabay_check = async function (key) {
  key = this._clean_key(key);
  if (!this._key_ascii_ok(key)) return [false, null, 'bad_key'];
  try {
    const r = await requests.get('https://pixabay.com/api/', { params: { key, q: 'test', per_page: 3 }, timeout: 8 });
    if (r.status_code === 200) return [true, 200, 'ok'];
    if ([400, 401, 403].includes(r.status_code)) return [false, r.status_code, 'bad_key'];
    if (r.status_code === 429) return [true, 429, 'rate'];
    return [false, r.status_code, 'http'];
  } catch (e) { return [false, null, netState(e)]; }
};
P.get_pixabay_key_status = async function () {
  if (!this.pixabay_key) return { has: false };
  const [, http, state] = await this._pixabay_check(this.pixabay_key);
  return { has: true, mask: Api._mask(this.pixabay_key), state, http };
};
P.set_pixabay_key = async function (key) {
  const keys = [];
  for (const p of (key || '').trim().split(/[\s,;]+/)) { const ck = this._clean_key(p); if (ck && !keys.includes(ck)) keys.push(ck); }
  this.pixabay_keys = keys; this.pixabay_key = keys[0] || ''; this._pix_key_idx = 0;
  this._invalidate_media_caches(); this._persist();
  if (!keys.length) return { ok: true, has: false };
  const [, http, state] = await this._pixabay_check(keys[0]);
  if (state === 'bad_key') {
    // веб: частая ошибка — в поле Pixabay вставили ключ Pexels (онбординг советует Pexels).
    // Рабочий ключ Pexels сохраняем как Pexels и считаем принятым.
    const [pok] = await this._pexels_check(keys[0]);
    if (pok) {
      this.pixabay_keys = []; this.pixabay_key = ''; this._invalidate_media_caches();
      if (!this.pexels_keys.includes(keys[0])) { this.pexels_keys = [keys[0]]; this._media_chain_obj = null; }
      this._persist();
      return { ok: true, has: true, mask: Api._mask(keys[0]), count: 1, state: 'ok', http: 200, moved_to: 'pexels' };
    }
  }
  return { ok: true, has: true, mask: Api._mask(keys[0]), count: keys.length, state, http };
};
P._pix_keys_view = function () { return this.pixabay_keys.map(k => ({ mask: Api._mask(k) })); };
P.get_pixabay_masks = function () { return { keys: this.pixabay_keys.map(k => ({ mask: Api._mask(k), status: 'checking' })), max: 1 }; };
P.get_pixabay_keys = async function () {
  const out = []; for (const k of this.pixabay_keys) { const [ok, , state] = await this._pixabay_check(k); out.push({ mask: Api._mask(k), ok: !!ok, state }); }
  return { keys: out, max: 1 };
};
P.add_pixabay_key = async function (key) {
  this.track('keys_saved');
  key = this._clean_key(key);
  if (!key) return { ok: false, msg: this._t('key_enter'), keys: this._pix_keys_view() };
  if (this.pixabay_keys.length >= 1) return { ok: false, msg: this._t('max_1_key'), keys: this._pix_keys_view() };
  if (this.pixabay_keys.includes(key)) return { ok: false, msg: this._t('key_already_added'), keys: this._pix_keys_view() };
  this.pixabay_keys.push(key); this.pixabay_key = this.pixabay_keys[0]; this._pix_key_idx = 0;
  this._invalidate_media_caches(); this._persist();
  const [, http, state] = await this._pixabay_check(key);
  return { ok: true, has: true, mask: Api._mask(key), state, http, keys: this._pix_keys_view() };
};
P.remove_pixabay_key = function (idx = 0) {
  const i = parseInt(idx); if (!Number.isNaN(i) && i >= 0 && i < this.pixabay_keys.length) this.pixabay_keys.splice(i, 1);
  this.pixabay_key = this.pixabay_keys[0] || ''; this._pix_key_idx = 0; this._invalidate_media_caches(); this._persist();
  return { ok: true, has: !!this.pixabay_keys.length, keys: this._pix_keys_view() };
};
P.open_pixabay_signup = function () { webbrowser.open(C.PIXABAY_SIGNUP); return true; };

P._pexels_check = async function (key) {
  key = this._clean_key(key);
  if (!this._key_ascii_ok(key)) return [false, null, 'bad_key'];
  try {
    const r = await requests.get('https://api.pexels.com/videos/search', { params: { query: 'test', per_page: 1 }, headers: { Authorization: key }, timeout: 8 });
    if (r.status_code === 200) return [true, 200, 'ok'];
    if ([401, 403].includes(r.status_code)) return [false, r.status_code, 'bad_key'];
    return [false, r.status_code, 'http'];
  } catch (e) { return [false, null, netState(e)]; }
};
P.get_pexels_key_status = async function () {
  if (!this.pexels_key) return { has: false };
  const [, http, state] = await this._pexels_check(this.pexels_key);
  return { has: true, mask: Api._mask(this.pexels_key), state, http };
};
P._pex_keys_view = function () { return this.pexels_keys.map(k => ({ mask: Api._mask(k) })); };
P.get_pexels_masks = function () { return { keys: this.pexels_keys.map(k => ({ mask: Api._mask(k), status: 'checking' })), max: 1 }; };
P.get_pexels_keys = async function () {
  const out = []; for (const k of this.pexels_keys) { const [ok, , state] = await this._pexels_check(k); out.push({ mask: Api._mask(k), ok: !!ok, state }); }
  return { keys: out, max: 1 };
};
P.add_pexels_key = async function (key) {
  this.track('keys_saved');
  key = this._clean_key(key);
  if (!key) return { ok: false, msg: this._t('key_enter'), keys: this._pex_keys_view() };
  if (this.pexels_keys.length >= 1) return { ok: false, msg: this._t('max_1_key'), keys: this._pex_keys_view() };
  if (this.pexels_keys.includes(key)) return { ok: false, msg: this._t('key_already_added'), keys: this._pex_keys_view() };
  this.pexels_keys.push(key); this._media_chain_obj = null; this._invalidate_media_caches(); this._persist();
  const [, http, state] = await this._pexels_check(key);
  return { ok: true, has: true, mask: Api._mask(key), state, http, keys: this._pex_keys_view() };
};
P.remove_pexels_key = function (idx = 0) {
  const i = parseInt(idx);
  if (!Number.isNaN(i) && i >= 0 && i < this.pexels_keys.length) { this.pexels_keys.splice(i, 1); this.pexels_idx = 0; this._media_chain_obj = null; this._invalidate_media_caches(); this._persist(); }
  return { ok: true, has: !!this.pexels_keys.length, keys: this._pex_keys_view() };
};
P.set_pexels_key = function (key) { return this.add_pexels_key(key); };
P.open_pexels_signup = function () { webbrowser.open(C.PEXELS_SIGNUP); return true; };

// Ссылки «получить ключ» из /key-links: окно открываем СРАЗУ (клик пользователя), адрес
// подставляем после ответа сервера — иначе браузер блокирует всплывающее окно.
P._key_link = async function (service, fallback) {
  try {
    let links = this._key_links_cache;
    if (links === undefined || links === null) {
      const r = await requests.get(`${VR_SERVER_URL}/key-links`, { timeout: 6 });
      links = r.status_code === 200 ? r.json() : {};
      this._key_links_cache = (links && typeof links === 'object') ? links : {};
      links = this._key_links_cache;
    }
    return String(links[service] || '').trim() || fallback;
  } catch (e) { return fallback; }
};
function openLater(urlPromise) {
  let w = null; try { w = window.open('about:blank', '_blank'); } catch (e) { }
  return Promise.resolve(urlPromise).then(u => { if (!u) { if (w) w.close(); return; } if (w) { try { w.opener = null; w.location.href = u; } catch (e) { webbrowser.open(u); } } else webbrowser.open(u); });
}
P.open_eleven_signup = function () { openLater(this._key_link('elevenlabs', 'https://try.elevenlabs.io/8x0as2j35ncg')); return true; };
P.get_bybit_link = async function () {
  if ((await this._key_link('bybit_show', '1')).trim() === '0') return '';
  return await this._key_link('bybit_buy_usdt', C['Api.BYBIT_DEFAULT']);
};
P.open_bybit = function () { const p = this.get_bybit_link(); openLater(p); return p.then(u => ({ ok: !!u })); };
