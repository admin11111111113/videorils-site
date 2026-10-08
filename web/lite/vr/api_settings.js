// Порт Api: стили видеоряда, «Из чужого видео»-настройки, _persist, голоса/пресеты (app.py 4596–5124).
import { C, save_settings, enc_secret, log, BUILD_VARIANT } from './core.js';
import { _sanitize_hex, _cap_colors_for } from './textutil.js';
import { Api } from './api_base.js';

const { VIDEO_STYLE_SUFFIX, CAP_ZONE_STYLES, CAP_PRESET_HEX, VOICES, VOICES_EN, MSGS } = C;
const P = Api.prototype;

P.set_reel_wishes = function (text) { this.reel_wishes = (text || '').trim(); this._persist(); return { ok: true }; };
P.set_video_styles = function (keys) { this.video_styles = (keys || []).filter(k => k in VIDEO_STYLE_SUFFIX); this._persist(); return { ok: true, styles: this.video_styles }; };
P.get_video_styles = function () { return { styles: this.video_styles }; };
P._styled_query = function (q) { const sel = this.video_styles.slice(0, 3); if (!sel.length) return q; return (q + ' ' + sel.map(k => VIDEO_STYLE_SUFFIX[k]).join(' ')).trim(); };
P.set_foreign_addition = function (text) { this.foreign_addition = (text || '').trim(); return { ok: true }; };
P.set_foreign_rewrite = function () { this.foreign_rewrite = 'free'; this._persist(); return { ok: true, mode: this.foreign_rewrite }; };
// Мини 1.2.118: режим кадров-исходника отключён — всегда False (как в app.py)
P._foreign_src_frames_active = function () { return false; };
P._target_sec = function () {
  const base = Number(this.reel_seconds || 0);
  if (this.reel_source === 'foreign') return Math.max(20.0, Math.min(40.0, base || 30.0));
  return base;
};
P.get_foreign_target = function () { return { ok: true, auto: false, seconds: Math.round(this._target_sec()) }; };
P.set_foreign_visual = function () { this.foreign_visual = 'stock'; this._persist(); return { ok: true, visual: this.foreign_visual }; };
P.set_foreign_hide_caps = function (on) { this.foreign_hide_caps = !!on; this._persist(); return { ok: true, on: this.foreign_hide_caps }; };
P.set_foreign_tail_trim = function (n) {
  const v = parseInt(n); this.foreign_tail_trim = Number.isNaN(v) ? 3 : Math.max(1, Math.min(10, v));
  this.foreign_len_manual = false; this._persist();
  return { ok: true, n: this.foreign_tail_trim, target: Math.round(this._target_sec()) };
};
P.set_foreign_color = function (on) { this.foreign_color = !!on; this._persist(); return { ok: true, on: this.foreign_color }; };
P.set_foreign_mirror = function (on) { this.foreign_mirror = !!on; this._persist(); return { ok: true, on: this.foreign_mirror }; };
P.get_foreign_visual = function () {
  const cs = {}; for (const [k, v] of Object.entries(CAP_ZONE_STYLES)) cs[k] = { css: v.css, textcss: v.textcss };
  return { ok: true, visual: this.foreign_visual, hide_caps: this.foreign_hide_caps, tail_trim: this.foreign_tail_trim,
    color: this.foreign_color, mirror: this.foreign_mirror, cap_zone: this.foreign_cap_zone, cap_style: this.foreign_cap_style,
    cap_color: this.foreign_cap_color || '#000000', cap_textcss: this._cap_colors().textcss, caps_cover: this.foreign_caps_cover || false, cap_styles: cs };
};
P._sanitize_cap_zone = function (z) {
  if (!z || typeof z !== 'object') return null;
  let x = parseFloat(z.x), y = parseFloat(z.y), w = parseFloat(z.w), h = parseFloat(z.h);
  if ([x, y, w, h].some(Number.isNaN)) return null;
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  w = Math.max(0, Math.min(1 - x, w)); h = Math.max(0, Math.min(1 - y, h));
  if (w < 0.03 || h < 0.02) return null;
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
};
P.set_foreign_cap_zone = function (x, y, w, h) { this.foreign_cap_zone = this._sanitize_cap_zone({ x, y, w, h }); this._persist(); return { ok: true, cap_zone: this.foreign_cap_zone }; };
P.clear_foreign_cap_zone = function () { this.foreign_cap_zone = null; this._persist(); return { ok: true, cap_zone: null }; };
Api._cap_zone_px = function (z) {
  const zx = Math.max(0, Math.min(1079, Math.round(z.x * 1080))), zy = Math.max(0, Math.min(1919, Math.round(z.y * 1920)));
  const zw = Math.max(2, Math.min(1080 - zx, Math.round(z.w * 1080))), zh = Math.max(2, Math.min(1920 - zy, Math.round(z.h * 1920)));
  return [zx, zy, zw, zh];
};
P._effective_cap_zone = function () {
  const z = this._sanitize_cap_zone(this.foreign_cap_zone);
  if (z) return z;
  if (this.foreign_caps_cover) return Object.assign({}, C['Api._COVER_BAND']);
  return null;
};
P._apply_cap_zone_style = function (rstyle, z) {
  let [zx, zy, zw, zh] = Api._cap_zone_px(z);
  if (this.foreign_mirror) zx = Math.max(0, 1080 - (zx + zw));
  rstyle.size = Math.max(34, Math.min(rstyle.size, Math.trunc(zh / 2.5)));
  const pad = 8;
  rstyle.align = 2; rstyle.marginl = Math.max(0, zx + pad); rstyle.marginr = Math.max(0, 1080 - (zx + zw) + pad);
  const th = rstyle.size * 1.25;
  const mv = Math.round(1920 - ((zy + zh / 2.0) + th / 2.0));
  rstyle.marginv = Math.max(0, Math.min(1920 - rstyle.size, mv));
  return rstyle;
};
P._cap_colors = function () { return _cap_colors_for(this.foreign_cap_color || '#000000'); };
P.set_foreign_cap_style = function (style) {
  const s = String(style || 'black'); this.foreign_cap_style = s in CAP_ZONE_STYLES ? s : 'black';
  this.foreign_cap_color = CAP_PRESET_HEX[this.foreign_cap_style] || '#000000'; this._persist();
  return { ok: true, cap_style: this.foreign_cap_style, cap_color: this.foreign_cap_color };
};
P.set_foreign_cap_color = function (hexs) {
  const h = _sanitize_hex(hexs);
  if (!h) return { ok: false, cap_color: this.foreign_cap_color };
  this.foreign_cap_color = h;
  const k = Object.entries(CAP_PRESET_HEX).find(([, v]) => v === h); if (k) this.foreign_cap_style = k[0];
  this._persist();
  return { ok: true, cap_color: h, textcss: this._cap_colors().textcss };
};
P.set_foreign_caps_cover = function (on) { this.foreign_caps_cover = !!on; this._persist(); return { ok: true, caps_cover: this.foreign_caps_cover }; };
// source-режим в Мини выключен: превью кадров зоны не нужны (UI их не вызывает)
P.foreign_preview_frames = function () { return { ok: false, err: 'no_source' }; };
P.foreign_preview_frame = function () { return this.foreign_preview_frames(1); };
P._foreign_src_thumb = function () { return ''; };
P._is_foreign_src_mode = function () { return false; };

P._persist = function () {
  save_settings({
    voice: this.reel_voice, rate: this.reel_rate, pitch: this.reel_pitch, presets: this.reel_presets,
    yt_style: this.yt_style, reel_style: this.reel_style, no_subs: this.no_subs,
    user_pron: this._user_pron || {}, auto_rematch: this.auto_rematch ?? true, defaults_v2: this.defaults_v2 ?? true,
    tts: { engine: this.tts_engine, piper_voice: this.piper_voice || 'irina', piper_speed: this.piper_speed || 0, eleven_voice: this.eleven_voice },
    elevenlabs_keys: this.eleven_keys.map(enc_secret), elevenlabs_key: this.eleven_key ? enc_secret(this.eleven_key) : '',
    keys_collapsed: this.keys_collapsed,
    pixabay_key: (this.pixabay_keys && this.pixabay_keys.length) ? enc_secret(this.pixabay_keys.join('\n')) : (this.pixabay_key ? enc_secret(this.pixabay_key) : ''),
    pexels_keys: this.pexels_keys.map(enc_secret), pexels_key: this.pexels_key ? enc_secret(this.pexels_key) : '',
    media_onboarded: !!this.media_onboarded,
    claude_keys: this.claude_keys.map(enc_secret), claude_key: this.claude_key ? enc_secret(this.claude_key) : '',
    ai_model: this.ai_model,
    gemini_keys: this.gemini_keys.map(enc_secret), gemini_key: this.gemini_key ? enc_secret(this.gemini_key) : '',
    gemini_model: this.gemini_model, ai_provider: this.ai_provider,
    el_dead_voices: [...this.el_dead_voices].sort(),
    music: { db: this.music_db, track: this.music_track, folders: this.music_folders, hidden: this.music_hidden },
    sfx_enabled: this.sfx_enabled, reel_wishes: this.reel_wishes, reel_scenario: this.reel_scenario,
    consent_version: this.consent_version, consent_date: this.consent_date, consent_machine: this.consent_machine,
    custom_prompts: this.custom_prompts, reel_emotion: this.reel_emotion, el_pronounce: this.el_pronounce,
    foreign_rewrite: this.foreign_rewrite, foreign_visual: this.foreign_visual, foreign_hide_caps: this.foreign_hide_caps,
    foreign_tail_trim: this.foreign_tail_trim, foreign_color: this.foreign_color, foreign_mirror: this.foreign_mirror,
    foreign_cap_zone: this.foreign_cap_zone, foreign_cap_style: this.foreign_cap_style, foreign_cap_color: this.foreign_cap_color || '#000000',
    foreign_caps_cover: this.foreign_caps_cover || false,
    outro: { enabled: this.outro_on, user_set: this.outro_user_set || false, text: this.outro_text, tg: this.outro_tg, site: this.outro_site,
      seconds: this.outro_seconds, voice: this.outro_voice, bg: this.outro_bg, color: this.outro_color, photo: this.outro_photo || '',
      stress: this.outro_stress_text || '', stress_manual: this.outro_stress_manual || [], show: this.outro_show, collapsed: this.outro_collapsed },
    video_styles: this.video_styles, reel_split_top: this.split_top_path, split_order: this.split_order,
    title: { text: this.title_text, xpct: this.title_xpct, ypct: this.title_ypct, fontpct: this.title_fontpct, theme: this.title_theme, title_on: this.title_on },
    ref_count: this.ref_count || 0, ref_lifetime: this.ref_lifetime || 0, ref_reward: this.ref_reward || 0, ref_per: this.ref_per ?? 5, ref_wallet: this.ref_wallet || '',
    sub_xpct: this.sub_xpct, sub_ypct: this.sub_ypct, sub_fontpct: this.sub_fontpct,
    content_lang: this.video_lang, ui_lang: this.ui_lang, voice_en: this.reel_voice_en,
  });
};
P._persist_voice = P._persist; P._persist_music = P._persist;

P.set_reel_voice = function (v) {
  if (v in VOICES) { this.reel_voice = v; this._persist_voice(); }
  else if (v in VOICES_EN) { this.reel_voice_en = v; this._persist_voice(); }
  return this.reel_voice;
};
P._active_content_lang = function () { return this._content_lang || this.video_lang || 'ru'; };
P._active_edge_voice = function () { return this._active_content_lang() === 'en' ? this.reel_voice_en : this.reel_voice; };
P.set_ui_lang = function (lang) { this.ui_lang = lang === 'en' ? 'en' : 'ru'; this._persist(); return this.ui_lang; };
P.get_ui_lang = function () { return this.ui_lang; };
P.get_build_variant = function () { return BUILD_VARIANT; };
P._t = function (key, ...args) {
  const [ru, en] = MSGS[key] || [key, key];
  let s = this.ui_lang === 'en' ? en : ru;
  if (args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m));
  return s;
};
P.set_reel_rate = function (n) { const v = Math.round(parseFloat(n)); this.reel_rate = Number.isNaN(v) ? 0 : Math.max(-30, Math.min(30, v)); this._persist_voice(); return this.reel_rate; };
P.set_reel_pitch = function (n) { const v = Math.round(parseFloat(n)); this.reel_pitch = Number.isNaN(v) ? 0 : Math.max(-20, Math.min(20, v)); this._persist_voice(); return this.reel_pitch; };
P.get_reel_settings = function () {
  const en = this.video_lang === 'en'; const src = en ? VOICES_EN : VOICES;
  return { voice: en ? this.reel_voice_en : this.reel_voice, rate: this.reel_rate, pitch: this.reel_pitch, presets: this.reel_presets,
    wishes: this.reel_wishes, content_lang: this.video_lang, voices: Object.entries(src).map(([id, name]) => ({ id, name })) };
};
P.save_voice_preset = function (name) {
  name = (name || '').trim();
  if (!name) return { ok: false, msg: this._t('voice_name_enter'), presets: this.reel_presets };
  const preset = { name, voice: this.reel_voice, rate: this.reel_rate, pitch: this.reel_pitch, engine: this.tts_engine, piper_voice: this.piper_voice || 'irina', piper_speed: this.piper_speed || 0 };
  this.reel_presets = this.reel_presets.filter(p => p.name !== name); this.reel_presets.push(preset); this._persist_voice();
  return { ok: true, presets: this.reel_presets, name };
};
P.delete_voice_preset = function (name) { this.reel_presets = this.reel_presets.filter(p => p.name !== name); this._persist_voice(); return { ok: true, presets: this.reel_presets }; };
P.apply_voice_preset = async function (name) {
  const { VOICE_SET } = await import('./piper.js');
  for (const p of this.reel_presets) {
    if (p.name === name) {
      if (p.voice in VOICES) this.reel_voice = p.voice;
      this.reel_rate = parseInt(p.rate ?? 0) || 0; this.reel_pitch = parseInt(p.pitch ?? 0) || 0;
      const eng = p.engine || 'edge'; if (['edge', 'piper', 'eleven', 'myvoice'].includes(eng)) this.tts_engine = eng;
      if (VOICE_SET.has(p.piper_voice)) this.piper_voice = p.piper_voice;
      if ('piper_speed' in p) this.piper_speed = parseInt(p.piper_speed ?? 0) || 0;
      this._persist_voice();
      return { ok: true, voice: this.reel_voice, rate: this.reel_rate, pitch: this.reel_pitch, engine: this.tts_engine, piper_voice: this.piper_voice || 'irina', piper_speed: this.piper_speed || 0 };
    }
  }
  return { ok: false, msg: this._t('preset_not_found') };
};
P.set_tts_engine = function (engine) { this.tts_engine = ['eleven', 'myvoice', 'piper'].includes(engine) ? engine : 'edge'; this._persist(); return this.tts_engine; };

// ---- стили субтитров для UI (app.py get_styles / get_ui_settings / set_reel_style) ----
P.get_styles = function () {
  return C.STYLES.map(s => ({
    name: s.name, css: s.css, bg: s.bg, fx: s.fx, desc: s.desc ?? '', desc_en: s.desc_en ?? '', mode: s.mode,
    keycss: s.keycss ?? '', keytextcss: s.keytextcss ?? '#ffffff', italic: !!(s.italic ?? 0), bold: !!(s.bold ?? 1),
    glow: !!s.keyglow, box: !!s.keybox, keybig: !!s.keybig, pop: !!s.keypop, cut: !!s.cut, underline: !!s.underline,
    ucss: s.ucss ?? '', fullbox: !!s.fullbox, boxcss: s.boxcss ?? '', gradbox: !!s.gradbox, hazard: !!s.hazard,
    neon: s.mode === 'neonglow', neonframe: !!s.neonframe, framecss: s.framecss ?? '', shadowcss: s.shadowcss ?? '',
    half: !!s.half, col1css: s.col1css ?? '', col2css: s.col2css ?? '', leftbar: !!s.leftbar, barcss: s.barcss ?? '',
    two: s.mode === 'twocolor', mono: false, grad: !!s.gradbox, karaoke: false,
  }));
};
P.get_ui_settings = function () { return { yt_style: this.yt_style, reel_style: this.reel_style, no_subs: this.no_subs }; };
P.set_reel_style = function (idx) { const v = parseInt(idx); this.reel_style = Number.isNaN(v) ? 0 : Math.max(0, Math.min(C.STYLES.length - 1, v)); this._persist(); return this.reel_style; };
