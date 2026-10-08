// Порт Api: стили видеоряда, «Из чужого видео»-настройки, _persist, голоса/пресеты (app.py 4596–5124).
import { C, save_settings, enc_secret, log, BUILD_VARIANT, vfs } from './core.js';
import { _sanitize_hex, _cap_colors_for } from './textutil.js';
import { Api } from './api_base.js';

const { VIDEO_STYLE_SUFFIX, CAP_ZONE_STYLES, CAP_PRESET_HEX, VOICES, VOICES_EN, MSGS } = C;
const P = Api.prototype;

P.set_reel_wishes = function (text) { this.reel_wishes = (text || '').trim(); this._persist(); return { ok: true }; };
P.set_video_styles = function (keys) { this.video_styles = (keys || []).filter(k => k in VIDEO_STYLE_SUFFIX); this._persist(); return { ok: true, styles: this.video_styles }; };
P.get_video_styles = function () { return { styles: this.video_styles }; };
P._styled_query = function (q) { const sel = this.video_styles.slice(0, 3); if (!sel.length) return q; return (q + ' ' + sel.map(k => VIDEO_STYLE_SUFFIX[k]).join(' ')).trim(); };
P.set_foreign_addition = function (text) { this.foreign_addition = (text || '').trim(); return { ok: true }; };
// free (по мотивам) | tight (близко к оригиналу) | subsonly (моё видео — только субтитры)
P.set_foreign_rewrite = function (mode) { this.foreign_rewrite = ['free', 'tight', 'subsonly'].includes(mode) ? mode : 'free'; this._persist(); return { ok: true, mode: this.foreign_rewrite }; };
P._foreign_src_frames_active = function () {
  return !!(this.reel_source === 'foreign' && (this.foreign_visual ?? 'source') === 'source'
    && this.foreign_audio_path && vfs.read(this.foreign_audio_path) && this._is_video_file(this.foreign_audio_path));
};
// длина исходника кэшируется при загрузке (_foreign_src_dur) — ffprobe_duration
P._target_sec = function () {
  const base = Number(this.reel_seconds || 0);
  if (this._foreign_src_frames_active() && !this.foreign_len_manual) {
    const d = Number(this._foreign_src_dur || 0);
    if (d > 1.5) { const tail = Number(this.foreign_tail_trim || 3); return Math.max(30.0, Math.min(120.0, d - tail)); }
  }
  return base;
};
P.get_foreign_target = function () {
  const auto = this._foreign_src_frames_active() && !this.foreign_len_manual;
  return { ok: true, auto, seconds: Math.round(this._target_sec()) };
};
P.set_foreign_visual = function (mode) {
  const nw = mode === 'stock' ? 'stock' : 'source';
  const changed = (this.foreign_visual ?? 'source') !== nw;
  this.foreign_visual = nw;
  // в АВТО только при реальном входе в режим кадров (ре-ассерт buildReel не трёт ручную длину)
  if (nw === 'source' && changed) this.foreign_len_manual = false;
  this._persist();
  return { ok: true, visual: this.foreign_visual };
};
P.set_foreign_hide_caps = function (on) { this.foreign_hide_caps = !!on; this._persist(); return { ok: true, on: this.foreign_hide_caps }; };
// приведение к 9:16: blur (весь кадр + размытая подложка) | crop (центр-кроп)
P.set_foreign_fit = function (mode) { this.foreign_fit = mode === 'crop' ? 'crop' : 'blur'; this._persist(); return { ok: true, fit: this.foreign_fit }; };
P.set_foreign_tail_trim = function (n) {
  const v = parseInt(n); this.foreign_tail_trim = Number.isNaN(v) ? 3 : Math.max(1, Math.min(10, v));
  this.foreign_len_manual = false; this._persist();
  return { ok: true, n: this.foreign_tail_trim, target: Math.round(this._target_sec()) };
};
P.set_foreign_color = function (on) { this.foreign_color = !!on; this._persist(); return { ok: true, on: this.foreign_color }; };
P.set_foreign_mirror = function (on) { this.foreign_mirror = !!on; this._persist(); return { ok: true, on: this.foreign_mirror }; };
P.get_foreign_visual = function () {
  const cs = {}; for (const [k, v] of Object.entries(CAP_ZONE_STYLES)) cs[k] = { css: v.css, textcss: v.textcss };
  return { ok: true, visual: this.foreign_visual, hide_caps: this.foreign_hide_caps, fit: this.foreign_fit || 'blur', tail_trim: this.foreign_tail_trim,
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
// превью-кадры исходника (тот же 9:16 cover/blur-letterbox, что и в сборке) — frames.js
P.foreign_preview_frames = async function (count = 6) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  const src = this.foreign_audio_path || '';
  if (!(src && vfs.read(src) && this._is_video_file(src))) return { ok: false, err: 'no_source' };
  let n = parseInt(count || 6); n = Number.isNaN(n) ? 6 : Math.max(1, Math.min(8, n));
  try {
    const { frameAt, mediaDur } = await import('./frames.js');
    const dur = (await mediaDur(src)) || 0.0;
    const blur = (this.foreign_fit || 'blur') === 'blur' && !this.foreign_hide_caps;
    this._thumb_tick = (this._thumb_tick || 0) + 1; const tick = this._thumb_tick;
    const usable = Math.max(0.5, dur - 0.6);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const frac = n > 1 ? 0.08 + (0.84 * (i / (n - 1))) : 0.5;
      const at = Math.max(0.2, Math.min(usable, usable * frac));
      const out = `temp/fv_zone_preview${i}.jpg`;
      try { await frameAt(src, at, out, { W: 360, H: 640, blur, zoom: !!this.foreign_hide_caps }); } catch (e) { continue; }
      if (vfs.read(out)) frames.push({ url: `temp/fv_zone_preview${i}.jpg?t=${tick}`, at: Math.round(at * 100) / 100 });
    }
    if (!frames.length) return { ok: false, err: 'extract_failed' };
    return { ok: true, frames, url: frames[0].url, dur: Math.round(dur * 100) / 100, w: 1080, h: 1920, zoom: !!this.foreign_hide_caps,
      cap_zone: this.foreign_cap_zone, cap_style: this.foreign_cap_style, cap_color: this.foreign_cap_color || '#000000', cap_textcss: this._cap_colors().textcss };
  } catch (e) { log(`  ⚠ превью зоны не извлеклось: ${e.message || e}`); return { ok: false, err: String(e.message || e) }; }
};
P.foreign_preview_frame = function () { return this.foreign_preview_frames(1); };
// миниатюра сцены #i из исходного видео (кадр по позиции сцены в ленте)
P._foreign_src_thumb = async function (i, n) {
  const src = this.foreign_audio_path || '';
  if (!(src && vfs.read(src) && this._is_video_file(src))) return '';
  try {
    const { frameAt, mediaDur } = await import('./frames.js');
    const dur = (await mediaDur(src)) || 0.0;
    const usable = Math.max(0.5, dur - Number(this.foreign_tail_trim || 3) - 0.3);
    const frac = n > 1 ? (0.08 + 0.84 * (i / (n - 1))) : 0.5;
    const at = Math.max(0.2, Math.min(usable, usable * frac));
    const blur = (this.foreign_fit || 'blur') === 'blur' && !this.foreign_hide_caps;
    this._sc_src_tick = (this._sc_src_tick || 0) + 1;
    const out = `temp/sc_src_${i}.jpg`;
    vfs.remove && vfs.remove(out);
    await frameAt(src, at, out, { W: 180, H: 320, blur, zoom: false });
    if (vfs.read(out)) return `temp/sc_src_${i}.jpg?t=${this._sc_src_tick}`;
  } catch (e) { }
  return '';
};
P._is_foreign_src_mode = function () { return this._foreign_src_frames_active(); };
P._persist = function () {
  save_settings({
    voice: this.reel_voice, rate: this.reel_rate, pitch: this.reel_pitch, presets: this.reel_presets,
    yt_style: this.yt_style, reel_style: this.reel_style, no_subs: this.no_subs,
    hook_cover: this.hook_cover ?? true, platform_icons: !!this.platform_icons,
    user_pron: this._user_pron || {},
    tts: { engine: this.tts_engine, piper_voice: this.piper_voice || 'irina', piper_speed: this.piper_speed || 0, eleven_voice: this.eleven_voice },
    // API-ключи — массивы до 5
    elevenlabs_keys: this.eleven_keys.map(enc_secret),
    elevenlabs_paused: this.eleven_keys.filter(k => this.eleven_paused && this.eleven_paused.has(k)).map(enc_secret),
    keys_collapsed: this.keys_collapsed,
    pixabay_keys: this.pixabay_keys.map(enc_secret),
    pexels_keys: this.pexels_keys.map(enc_secret),
    media_onboarded: !!this.media_onboarded,
    claude_keys: this.claude_keys.map(enc_secret),
    ai_model: this.ai_model,
    gemini_keys: this.gemini_keys.map(enc_secret),
    gemini_model: this.gemini_model, ai_provider: this.ai_provider,
    el_dead_voices: [...this.el_dead_voices].sort(),
    logo: { src: this.logo_src, pos: this.logo_pos, xpct: this.logo_xpct, ypct: this.logo_ypct, size: this.logo_size, opacity: this.logo_opacity, on: this.logo_on, removebg: this.logo_removebg },
    music: { db: this.music_db, track: this.music_track, folders: this.music_folders, voice_vol: this.voice_vol, hidden: this.music_hidden },
    clipmix: { theme: this.clipmix_theme ?? '', cps: this.clipmix_cps ?? 2, len: this.clipmix_len ?? 20, caption: this.clipmix_caption ?? '',
      caption_on: this.clipmix_caption_on ?? false, caption_pos: this.clipmix_caption_pos ?? 'top',
      cap_xpct: this.clipmix_cap_xpct ?? 0.5, cap_ypct: this.clipmix_cap_ypct ?? 0.86, cap_fontpct: this.clipmix_cap_fontpct ?? 0.052,
      hook: this.clipmix_hook ?? '', hook_stress: this.clipmix_hook_stress ?? '', hook_stress_manual: this.clipmix_hook_stress_manual ?? [],
      beatsync: this.clipmix_beatsync ?? false, music: this.clipmix_music ?? '', source: this.clipmix_source ?? 'auto', folder: this.clipmix_folder ?? '' },
    sfx_enabled: this.sfx_enabled, reel_wishes: this.reel_wishes, reel_scenario: this.reel_scenario,
    consent_version: this.consent_version, consent_date: this.consent_date, consent_machine: this.consent_machine,
    foreign_rewrite: this.foreign_rewrite, foreign_visual: this.foreign_visual, foreign_hide_caps: this.foreign_hide_caps,
    foreign_fit: this.foreign_fit || 'blur',
    foreign_tail_trim: this.foreign_tail_trim, foreign_color: this.foreign_color, foreign_mirror: this.foreign_mirror,
    foreign_cap_zone: this.foreign_cap_zone, foreign_cap_style: this.foreign_cap_style, foreign_cap_color: this.foreign_cap_color || '#000000',
    foreign_caps_cover: this.foreign_caps_cover || false,
    auto_rematch: this.auto_rematch ?? true, defaults_v2: this.defaults_v2 ?? true,
    custom_prompts: this.custom_prompts, reel_emotion: this.reel_emotion, el_pronounce: this.el_pronounce,
    outro: { enabled: this.outro_on, user_set: this.outro_user_set || false, text: this.outro_text, tg: this.outro_tg, site: this.outro_site,
      seconds: this.outro_seconds, voice: this.outro_voice, bg: this.outro_bg, color: this.outro_color, photo: this.outro_photo || '',
      stress: this.outro_stress_text || '', stress_manual: this.outro_stress_manual || [], show: this.outro_show },
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
    neon: s.mode === 'neonglow', anim: !!(s.anim ?? false), neonframe: !!s.neonframe, framecss: s.framecss ?? '', shadowcss: s.shadowcss ?? '',
    half: !!s.half, col1css: s.col1css ?? '', col2css: s.col2css ?? '', leftbar: !!s.leftbar, barcss: s.barcss ?? '',
    two: s.mode === 'twocolor', mono: false, grad: !!s.gradbox, karaoke: false,
  }));
};
P.get_ui_settings = function () { return { yt_style: this.yt_style, reel_style: this.reel_style, no_subs: this.no_subs, platform_icons: !!this.platform_icons }; };
P.set_reel_style = function (idx) { const v = parseInt(idx); this.reel_style = Number.isNaN(v) ? 0 : Math.max(0, Math.min(C.STYLES.length - 1, v)); this._persist(); return this.reel_style; };
