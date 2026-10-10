// Порт class Api: __init__ + лицензия/триал/промо/рефералы/оплата (app.py 2918–4595).
import {
  C, APP_VERSION, VR_SERVER_URL, CF_URL, BUILD_VARIANT, load_settings, save_settings, dec_secret, enc_secret,
  log, call_js, sleep, now, requests, webbrowser, thread, store, sha256Hex, uuid4hex, isoNow, strftime, re,
} from './core.js';
import { _sanitize_hex } from './textutil.js';
import { PIX } from './media.js';

const { VOICES, VOICES_EN, VIDEO_STYLE_SUFFIX, STYLES, CAP_ZONE_STYLES, CAP_PRESET_HEX, TITLE_THEMES, REEL_PROMPTS, EMOTIONS, DOCS_VERSION } = C;
const _EDITION = C._EDITION;
const LIC_KEY = 'vr_mini_license', TRIAL_KEY = 'vr_mini_trial', MID_KEY = 'vr_mini_machine', FIRST_KEY = 'vr_mini_first_launch';
const WEB_PLANS_FB = { web_week: { type: 'weekly', rub: 539, days: 7 }, web_month: { type: 'monthly', rub: 1199, days: 30 }, web_year: { type: 'yearly', rub: 8990, days: 365 } };

// ── РЕФЕРАЛЬНЫЙ КОД (тот же алгоритм, что в app.py/Лайте/сервере) ──
export async function referral_code(key) {
  const k = (key || '').trim().toUpperCase();
  if (!k) return '';
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(C._REF_SALT + ':' + k)));
  let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(dig[i]);
  const A = C._REF_ALPHABET, L = BigInt(A.length); let out = '';
  for (let i = 0; i < C._REF_LEN; i++) { out += A[Number(n % L)]; n /= L; }
  return out;
}
export async function referral_link(key) { const c = await referral_code(key); return c ? C.REF_LINK_BASE + c : ''; }
export function normalize_ref_code(code) {
  let s = String(code || '').trim();
  const m = re.search('[?&#]ref=([^&#\\s]+)', s, 'i');
  if (m) s = m.group(1);
  else if (s.toLowerCase().includes('ref=') || s.includes('/')) { const p = s.split(/[/=]/); s = p[p.length - 1]; }
  const c = s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return [...c].filter(ch => C._REF_ALPHABET.includes(ch)).join('').slice(0, C._REF_LEN);
}
function fromIso(s) { const d = new Date(s); return isNaN(d) ? null : d; }
function daysBetween(a, b) { return Math.floor((a - b) / 86400000); }

export class Api {
  constructor() {
    const BV = BUILD_VARIANT;
    this.platform = 'reel';
    this.video_lang = BV; this.video_lang_label = BV === 'en' ? 'ENGLISH' : 'РУССКИЙ';
    this.audio_path = null; this.segments = []; this.images = {}; this.highlights = {}; this.reels = []; this.last_video = null;
    this.reel_seconds = 30; this.reel_source = 'scratch';
    const s = load_settings();
    const cl = s.content_lang ?? BV;
    this.video_lang = cl === 'en' ? 'en' : 'ru';
    this.video_lang_label = this.video_lang === 'en' ? 'ENGLISH' : 'РУССКИЙ';
    this.ui_lang = (s.ui_lang ?? BV) === 'en' ? 'en' : 'ru';
    this._user_pron = {};
    for (const [k, v] of Object.entries(s.user_pron || {})) { const kk = String(k).trim().toLowerCase(), vv = String(v).trim(); if (kk && vv) this._user_pron[kk] = vv; }
    this._pron_server = {};
    this._rebuild_pron();
    this.reel_voice = s.voice ?? 'ru-RU-DmitryNeural'; if (!(this.reel_voice in VOICES)) this.reel_voice = 'ru-RU-DmitryNeural';
    this.reel_voice_en = s.voice_en ?? 'en-US-AriaNeural'; if (!(this.reel_voice_en in VOICES_EN)) this.reel_voice_en = 'en-US-AriaNeural';
    this.reel_rate = parseInt(s.rate ?? 0) || 0; this.reel_pitch = parseInt(s.pitch ?? 0) || 0;
    this.reel_presets = s.presets ?? [];
    const mu = s.music ?? {};
    this.music_db = parseInt(mu.db ?? -19); if (Number.isNaN(this.music_db)) this.music_db = -19;
    this.music_track = ''; this.music_folders = mu.folders ?? [];
    this.music_hidden = (mu.hidden ?? []).map(p => String(p).toLowerCase());
    this.yt_style = parseInt(s.yt_style ?? 0) || 0;
    this.reel_style = Math.max(0, Math.min(STYLES.length - 1, parseInt(s.reel_style ?? 0) || 0));
    this.no_subs = !!(s.no_subs ?? false);
    this.auto_rematch = s.defaults_v2 ? !!(s.auto_rematch ?? true) : true;
    this.defaults_v2 = true;
    const tt = s.tts ?? {};
    this.tts_engine = tt.engine ?? 'edge';
    this.piper_voice = tt.piper_voice ?? 'irina'; this.piper_speed = parseInt(tt.piper_speed ?? 0) || 0;
    this.eleven_voice = tt.eleven_voice ?? '';
    this.eleven_keys = (s.elevenlabs_keys || []).filter(Boolean).map(dec_secret).filter(Boolean);
    if (!this.eleven_keys.length) {
      const o = dec_secret(s.elevenlabs_key || '');
      if (o) this.eleven_keys = [o]; else if (tt.keys) this.eleven_keys = tt.keys.map(x => dec_secret(x.key || '')).filter(Boolean);
    } else { const o = dec_secret(s.elevenlabs_key || ''); if (o && !this.eleven_keys.includes(o)) this.eleven_keys.unshift(o); }
    this.eleven_keys = this.eleven_keys.slice(0, 1);
    this.eleven_idx = 0; this._force_edge = false;
    this.el_dead_voices = new Set(s.el_dead_voices || []);
    this.myvoice_path = ''; this.myvoice_segments = [];
    this.reel_wishes = s.reel_wishes ?? '';
    this.video_styles = (s.video_styles || []).filter(k => k in VIDEO_STYLE_SUFFIX);
    this.ref_count = parseInt(s.ref_count || 0) || 0; this.ref_lifetime = parseInt(s.ref_lifetime || 0) || 0;
    this.ref_reward = parseFloat(s.ref_reward || 0) || 0; this.ref_per = parseFloat(s.ref_per || 5) || 5;
    this.ref_wallet = String(s.ref_wallet || '');
    this.sub_xpct = parseFloat(s.sub_xpct ?? 0.5); this.sub_ypct = parseFloat(s.sub_ypct ?? 0.8);
    this.sub_fontpct = parseFloat(s.sub_fontpct ?? 0.05);
    this.foreign_addition = ''; this.foreign_rewrite = 'free'; this.foreign_visual = 'stock';
    this.foreign_hide_caps = !!(s.foreign_hide_caps ?? false);
    this.foreign_tail_trim = Math.max(1, Math.min(10, parseInt(s.foreign_tail_trim ?? 3) || 3));
    this.foreign_color = !!(s.foreign_color ?? true); this.foreign_mirror = !!(s.foreign_mirror ?? false);
    this.foreign_cap_zone = this._sanitize_cap_zone(s.foreign_cap_zone);
    const _cs = String(s.foreign_cap_style || 'black');
    this.foreign_cap_style = _cs in CAP_ZONE_STYLES ? _cs : 'black';
    this.foreign_cap_color = _sanitize_hex(s.foreign_cap_color) || CAP_PRESET_HEX[this.foreign_cap_style] || '#000000';
    this.foreign_caps_cover = !!(s.foreign_caps_cover ?? false);
    this.foreign_len_manual = false;
    const _pk = dec_secret(s.pixabay_key ?? s.pixabay ?? '');
    let raw_keys = (_pk || '').split('\n').map(k => k.trim()).filter(Boolean);
    if (!raw_keys.length) raw_keys = (s.pixabay_keys || []).map(dec_secret).filter(Boolean);
    this.pixabay_keys = raw_keys.slice(0, 1); this.pixabay_key = this.pixabay_keys[0] || ''; this._pix_key_idx = 0;
    this.pexels_keys = (s.pexels_keys || []).filter(Boolean).map(dec_secret).filter(Boolean);
    { const o = dec_secret(s.pexels_key || ''); if (o && !this.pexels_keys.includes(o)) this.pexels_keys.unshift(o); }
    this.pexels_keys = this.pexels_keys.slice(0, 1); this.pexels_idx = 0;
    this._media_chain_obj = null;
    this.media_onboarded = !!(s.media_onboarded ?? false);
    this.claude_keys = (s.claude_keys || []).filter(Boolean).map(dec_secret).filter(Boolean);
    { const o = dec_secret(s.claude_key || ''); if (o && !this.claude_keys.includes(o)) this.claude_keys.unshift(o); }
    this.claude_keys = this.claude_keys.slice(0, 1); this.claude_idx = 0;
    this.ai_model = s.ai_model ?? 'sonnet'; if (!['sonnet', 'opus'].includes(this.ai_model)) this.ai_model = 'sonnet';
    this.gemini_keys = (s.gemini_keys || []).filter(Boolean).map(dec_secret).filter(Boolean);
    { const o = dec_secret(s.gemini_key || ''); if (o && !this.gemini_keys.includes(o)) this.gemini_keys.unshift(o); }
    this.gemini_keys = this.gemini_keys.slice(0, 1); this.gemini_idx = 0;
    this.gemini_model = 'flash';
    this.ai_provider = s.ai_provider ?? 'claude'; if (!['claude', 'gemini'].includes(this.ai_provider)) this.ai_provider = 'claude';
    this._ai_last_status = 0; this._ai_last_reason = ''; this._cred_cache = {};
    this.reel_text = ''; this.foreign_audio_path = null; this.foreign_segments = [];
    this.reel_phrases = []; this.reel_spoken = []; this.reel_segments = [];
    this.reel_media_source = 'auto';
    this.split_top_path = s.reel_split_top ?? ''; this.split_order = s.split_order ?? 'video_top';
    const tt2 = s.title ?? {};
    this.title_text = tt2.text ?? ''; this.title_xpct = parseFloat(tt2.xpct ?? 0.5); this.title_ypct = parseFloat(tt2.ypct ?? 0.5);
    this.title_fontpct = parseFloat(tt2.fontpct ?? 0.05);
    this.title_theme = tt2.theme ?? 'T1'; if (!(this.title_theme in TITLE_THEMES)) this.title_theme = 'T1';
    this.title_on = !!(tt2.title_on ?? false);
    this.reel_media = []; this.reel_sfx = {};
    this.sfx_enabled = !!(s.sfx_enabled ?? true);
    this.reel_images = {}; this.reel_highlights = {}; this.reel_scene_picks = {}; this.reel_scene_starts = {};
    this.last_reel = null;
    this.keys_collapsed = s.keys_collapsed ?? true;
    this.consent_version = s.consent_version ?? ''; this.consent_date = s.consent_date ?? ''; this.consent_machine = s.consent_machine ?? '';
    this.reel_scenario = s.reel_scenario ?? 'auto';   // веб: по умолчанию «Авто» (просьба владельца 2026-10-08)
    if (!(this.reel_scenario in REEL_PROMPTS) && this.reel_scenario !== 'auto') this.reel_scenario = 'auto';
    this.reel_auto_type = ''; this.custom_prompts = {};
    this.reel_caption = ''; this.reel_hashtags = ''; this.reel_topic = '';
    this.reel_emotion = s.reel_emotion ?? 'energetic';
    this.el_pronounce = false; this._pron_cache = {}; this._stress_cache = {};
    if (!(this.reel_emotion in EMOTIONS)) this.reel_emotion = 'energetic';
    this._session_hooks = []; this.reel_scenes = []; this.reel_scene_clips = {}; this._scene_clip_cache = {};
    this._thumb_tick = 0; this._reel_used_clips = null; this.clip_provider = 'm1'; this._swap_seen = {}; this._scene_swap_state = {};
    const o = s.outro ?? {};
    this.outro_on = o.user_set ? !!(o.enabled ?? false) : false;
    this.outro_user_set = !!(o.user_set ?? false);
    this.outro_text = o.text ?? 'Продолжение в моём Телеграм';
    this.outro_tg = o.tg ?? ''; this.outro_site = o.site ?? '';
    this.outro_seconds = Math.max(3, Math.min(6, parseInt(o.seconds ?? 3) || 3));
    this.outro_voice = !!(o.voice ?? false);
    this.outro_collapsed = o.collapsed ?? null;
    this.outro_bg = o.bg ?? 'color'; if (!['color', 'gradient', 'blur', 'photo'].includes(this.outro_bg)) this.outro_bg = 'color';
    this.outro_color = this._norm_hex(o.color ?? '#0a1712', '#0a1712');
    this.outro_photo = o.photo ?? '';
    if (this.outro_bg === 'photo' && !(this.outro_photo && this._outro_photo_exists())) this.outro_bg = 'color';
    const sh = (o.show || {});
    this.outro_show = { tg_qr: !!(sh.tg_qr ?? true), tg_nick: !!(sh.tg_nick ?? true), site_qr: !!(sh.site_qr ?? true), site_link: !!(sh.site_link ?? true) };
    this.outro_stress_text = o.stress ?? ''; this.outro_stress_manual = [...(o.stress_manual || [])];
    this.busy = false; this.trial_active = false;
    this.promo_active = false; this.promo_code = ''; this.promo_days_left = 0;
    this._machine_id = ''; this._funnel_id_cache = '';
    this._load_license();
  }

  // ==================== ЛИЦЕНЗИЯ ====================
  _ping_render() { thread(async () => { try { await requests.post(`${VR_SERVER_URL}/ping-render`, { json: { product: 'mini' }, timeout: 3 }); } catch (e) { } }); }
  report_client_error(error_type, message = '', stage = '') {
    thread(async () => { try { await requests.post(`${VR_SERVER_URL}/client-error`, { json: { machine_id: await this.get_machine_id(), app_version: APP_VERSION + '-web', error_type: String(error_type).slice(0, 60), message: String(message).slice(0, 200), stage: String(stage).slice(0, 24) }, timeout: 5 }); } catch (e) { } });
    return { ok: true };
  }
  static _ver_tuple(v) { try { return String(v).trim().split('.').map(x => { const n = parseInt(x); if (Number.isNaN(n)) throw 0; return n; }); } catch (e) { return [0]; } }
  // веб-версия обновляется сама (страница) — апдейтер десктопа не нужен
  check_app_update() { return { update: false, web: true, current: APP_VERSION }; }
  download_and_install_update() { return { ok: false, msg: 'Веб-версия обновляется автоматически' }; }
  open_update_download(url) { const u = (url || '').trim(); if (u.startsWith('https://github.com/')) { webbrowser.open(u); return { ok: true }; } return { ok: false }; }

  static _gem_classify(prompt) {
    const pl = (prompt || '').slice(0, 600).toLowerCase();
    if (pl.includes('ответь одним словом: привет') || pl.includes('ответь одним словом: тест')) return 'проверка ключа';
    if (pl.includes('расставь ударения в каждом пронумерован')) return 'ударения (БАТЧ всех сцен)';
    if (pl.includes('после каждой ударной гласной')) return 'ударения (ОДНА сцена — фолбэк)';
    if (pl.includes('слишком коротк')) return 'добор длины';
    if (pl.includes('слишком длинн')) return 'ужатие под лимит';
    if (pl.includes('строго по теме исходника')) return 'topic-drift регенерация';
    if (pl.includes('english_query') || pl.includes('english query')) return 'rematch клипа (ОДНА сцена)';
    if (pl.includes('пауз') && (pl.includes('числ') || pl.includes('прописью'))) return 'pron-разметка ElevenLabs (ОДНА сцена)';
    if (pl.includes('варианты') && (pl.includes('хук') || pl.includes('первой фраз'))) return 'варианты хука (1 вызов = N вариантов)';
    if (pl.includes('тип') && pl.includes('формат') && pl.includes('истори')) return 'классификация темы';
    return 'сценарий/прочее';
  }
  _log_gem_call(prompt, mid, status, attempt) {
    try { console.debug(`${strftime('%H:%M:%S')} | ${Api._gem_classify(prompt)} | ${mid} | HTTP ${status} | try${attempt + 1}`); } catch (e) { }
  }
  _log_gem_429(r) { try { console.debug('---- 429 ----\n' + (r.text || '').slice(0, 2000)); } catch (e) { } }

  // триал и проверка ключа — через Cloudflare (отвечает сразу, не засыпает); недоступен -> сервер лицензий
  async _cf_post(path, payload) {
    payload = Object.assign({ client: 'web' }, payload || {});
    try {
      const r = await requests.post(CF_URL + path, { json: payload, timeout: [6, 55] });
      if (r.status_code === 200) return r.json();
      if (r.status_code >= 400 && r.status_code < 500) return null;
    } catch (e) { }
    return await this._server_post(path, payload);
  }
  async _server_post(path, payload) {
    payload = Object.assign({ client: 'web' }, payload || {});   // веб = место «браузер» у ключа (1 ПК + 1 браузер)
    const url = VR_SERVER_URL.replace(/\/+$/, '') + path;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await requests.post(url, { json: payload, timeout: [10, 55] });
        if (r.status_code === 200) return r.json();
        if (r.status_code >= 400 && r.status_code < 500) return null;
      } catch (e) { }
    }
    return null;
  }

  report_stress(word, stress = '') {
    const w = (word || '').trim().toLowerCase();
    if (!w) return { ok: false };
    thread(async () => { try { await this._server_post('/report-stress', { machine: await this.get_machine_id(), word: w.slice(0, 40), stress: (stress || '').slice(0, 60), app_version: APP_VERSION }); } catch (e) { } });
    return { ok: true };
  }
  _rebuild_pron() { this._TTS_FIX = Object.assign({}, C['Api._TTS_FIX'], this._pron_server || {}, this._user_pron || {}); }
  static _caps_to_stress(s) {
    const vow_up = 'АЕЁИОУЫЭЮЯ'; let out = '', done = false;
    for (const ch of (s || '')) { if (!done && vow_up.includes(ch)) { out += ch.toLowerCase() + '́'; done = true; } else out += ch.toLowerCase(); }
    return out;
  }
  async preview_pron(text) {
    if (this.busy) return { ok: false, msg: this._t('processing') };
    const t = Api._caps_to_stress((text || '').trim().slice(0, 80));
    if (![...t].some(c => (c >= 'а' && c <= 'я') || c === 'ё')) return { ok: false };
    const out = 'temp/pron_preview.mp3';
    const eng = this.tts_engine || 'edge', prev = this._force_edge;
    try {
      if (eng === 'eleven' || eng === 'myvoice') this._force_edge = true;
      this._tts_preview = true;                       // прослушивание — быстрые повторы, без долгого ожидания
      await this._synth_one(t, out, { keep_stress: true });
      return { ok: true, url: out + '?t=' + Math.trunc(Date.now() / 1000) };   // как в приложении — СТРОКА-ссылка (get_play_url отдаёт объект)
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
    finally { this._force_edge = prev; this._tts_preview = false; }
  }
  apply_local_pron(word, form) {
    const w = (word || '').trim().toLowerCase().slice(0, 40);
    const f = Api._caps_to_stress((form || '').trim().slice(0, 60));
    const letters = [...w].filter(c => (c >= 'а' && c <= 'я') || c === 'ё').join('');
    const lat = [...w].filter(c => c >= 'a' && c <= 'z').join('');
    if (!w || !(letters || lat)) return { ok: false, msg: this._t('pron_need_word') };
    if (!(f && re.match(C['Api._PRON_OK'], f) && re.match(C['Api._PRON_OK'], f).group(0).length === f.length)) return { ok: false, msg: this._t('pron_bad_form') };
    this._user_pron[w] = f; this._rebuild_pron(); this._stress_cache = {}; this._persist();
    if (letters && !lat) { try { this.report_stress(w, f); } catch (e) { } }
    return { ok: true, word: w, form: f };
  }
  remove_local_pron(word) { const w = (word || '').trim().toLowerCase(); if (this._user_pron) delete this._user_pron[w]; this._rebuild_pron(); this._stress_cache = {}; this._persist(); return { ok: true }; }
  get_local_pron() { const d = this._user_pron || {}; return { prons: Object.keys(d).sort().map(k => ({ word: k, form: d[k] })) }; }
  fetch_pron_dict() {
    thread(async () => {
      try {
        const r = await requests.get(CF_URL + '/pronunciation-dict?machine_id=' + await this.get_machine_id(), { timeout: [10, 55] });
        if (r.status_code !== 200) return;
        const d = (r.json() || {}).dict || {}; const srv = {}; let add = 0;
        for (const [w, s] of Object.entries(d)) {
          if (typeof w !== 'string' || typeof s !== 'string') continue;
          const wl = w.trim().toLowerCase(), sv = s.trim();
          if (wl && sv && re.fullmatch('[А-Яа-яЁё́ \\-]{1,60}', sv)) { srv[wl] = sv; add++; }
        }
        this._pron_server = srv; this._rebuild_pron();
        if (add) log(`🔤 Словарь произношения с сервера: +${add} слов (краудсорс)`);
      } catch (e) { }
    });
    return { ok: true };
  }
  async get_launch_stats() {
    try {
      const r = await requests.get(CF_URL + '/stats', { timeout: [10, 55] });
      if (r.status_code === 200) { const d = r.json(); return { ok: true, stage: d.stage, current_price: d.current_price, current_price_rub: d.current_price_rub, remaining_in_stage: d.remaining_in_stage, next_price: d.next_price, next_price_rub: d.next_price_rub }; }
    } catch (e) { }
    return { ok: false };
  }
  async _ref_for_purchase(plan, ref) {
    if ((plan || '').trim().toLowerCase() !== 'lifetime') return '';
    ref = normalize_ref_code(ref);
    if (!ref || ref.length < C._REF_LEN) return '';
    const own = await referral_code(this.license_key || '');
    return (own && ref === own) ? '' : ref;
  }
  async set_pending_ref(ref) { this._pending_ref = await this._ref_for_purchase('lifetime', ref); return { ok: true }; }
  async reserve_purchase(plan = 'lifetime', ref = '') {
    plan = (plan || 'lifetime').trim().toLowerCase(); if (!['monthly', 'yearly', 'lifetime'].includes(plan)) plan = 'lifetime';
    const body = { machine: await this.get_machine_id(), product: 'mini', plan, key: this.license_key || '' };
    const _r = await this._ref_for_purchase(plan, ref); if (_r) { body.ref = _r; this._pending_ref = _r; }
    const resp = await this._server_post('/reserve', body);
    if (resp === null) return { ok: false, reachable: false, msg: this._t('lic_server_down') };
    if (resp.status !== 'ok') return { ok: false, msg: resp.msg || this._t('pay_soldout') };
    return { ok: true, amount: resp.amount, wallet: resp.wallet || '', network: resp.network || 'TRC-20', expires_in: resp.expires_in || 1800 };
  }
  async reserve_purchase_rub(plan = 'lifetime', ref = '') {
    plan = (plan || 'lifetime').trim().toLowerCase(); if (!['monthly', 'yearly', 'lifetime', 'web_week', 'web_month', 'web_year'].includes(plan)) plan = 'lifetime';
    const body = { machine: await this.get_machine_id(), product: 'mini', plan, key: this.license_key || '', title: 'Видеорилс Мини' };
    const _r = await this._ref_for_purchase(plan, ref); if (_r) { body.ref = _r; this._pending_ref = _r; }
    const resp = await this._server_post('/prodamus/create-link', body);
    if (resp === null) return { ok: false, reachable: false, msg: this._t('lic_server_down') };
    if (resp.status !== 'ok' || !resp.link) return { ok: false, msg: resp.msg || this._t('pay_soldout') };
    webbrowser.open(resp.link);
    return { ok: true, amount: resp.amount_usd, amount_rub: resp.amount_rub, link: resp.link };
  }
  open_pay_link_rub(link) { webbrowser.open(link); return { ok: true }; }
  async check_payment(amount, ref = '') {
    if (!this._consent_ok()) return { ok: false, need_consent: true, msg: this._t('consent_need') };
    const body = { machine: await this.get_machine_id(), amount };
    const _r = (await this._ref_for_purchase('lifetime', ref)) || this._pending_ref || ''; if (_r) body.ref = _r;
    const resp = await this._server_post('/payment-status', body);
    if (resp === null) return { ok: false, reachable: false, msg: this._t('lic_server_down') };
    if (resp.status === 'paid' && resp.key) {
      const key = resp.key.trim().toUpperCase(); const ltype = resp.type || 'lifetime'; const now_iso = isoNow();
      const exp = (resp.expires && String(resp.expires).length >= 10) ? String(resp.expires).slice(0, 10) : this._license_expiry(ltype, now_iso);
      store.set(LIC_KEY, JSON.stringify({ key, type: ltype, activated: now_iso, expires: exp }));
      Object.assign(this, { license_key: key, license_type: ltype, license_activated: now_iso, license_expires: exp, licensed: true });
      return { ok: true, paid: true, key };
    }
    return { ok: true, paid: false };
  }
  async payment_qr(text) {
    try { const { qrDataUrl } = await import('./qr.js'); return { ok: true, data: await qrDataUrl(text || '', 320) }; }
    catch (e) { return { ok: false, msg: String(e.message || e) }; }
  }
  async _validate_key(key) {
    key = (key || '').trim().toUpperCase();
    if (!key) return { ok: false, status: 'invalid', reachable: true, msg: this._t('lic_bad') };
    if (C['Api._VALID_TEST_KEYS'].has(key)) return { ok: true, status: 'ok', reachable: true, type: 'dev' };
    const resp = await this._cf_post('/check', { key, machine: await this.get_machine_id(), product: 'mini' });
    if (resp === null) return { ok: false, status: 'offline', reachable: false, msg: this._t('lic_server_down') };
    this._store_ref_stats(resp.referrals);
    const st = resp.status;
    if (st === 'ok') return { ok: true, status: 'ok', reachable: true, type: resp.type || 'lifetime' };
    return { ok: false, status: st, reachable: true, msg: resp.msg || this._t('lic_bad') };
  }
  _load_license() {
    this.license_key = ''; this.license_type = 'lifetime'; this.license_activated = ''; this.license_expires = ''; this.licensed = false;
    try {
      const data = JSON.parse(store.get(LIC_KEY) || 'null');
      if (data && data.key) {
        this.license_key = String(data.key).trim().toUpperCase(); this.license_type = data.type || 'lifetime';
        this.license_activated = data.activated || ''; this.license_expires = data.expires || ''; this.licensed = true;
      }
    } catch (e) { }
    if (this.license_key) thread(() => this._revalidate_license());
  }
  async _revalidate_license() {
    const res = await this._validate_key(this.license_key);
    if (!res.reachable) return;
    if (res.ok) this.licensed = true; else { this.licensed = false; store.del(LIC_KEY); }
    call_js('licenseState', { licensed: this.licensed, msg: res.msg || '' });
  }
  _license_expiry(lic_type, activated_iso) {
    if (!['weekly', 'monthly', 'yearly'].includes(lic_type)) return '';
    const base = fromIso(activated_iso) || new Date();
    const d = new Date(base.getTime() + ({ weekly: 7, monthly: 30 }[lic_type] || 365) * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  _store_ref_stats(block) {
    if (!block || typeof block !== 'object') return;
    const total = parseInt(block.count || 0) || 0, life = parseInt(block.lifetime ?? block.count ?? 0) || 0;
    let per = block.per; per = per != null && !Number.isNaN(parseFloat(per)) ? parseFloat(per) : C['Api._REF_REWARD_USD'];
    this.ref_count = Math.max(0, total); this.ref_lifetime = Math.max(0, life); this.ref_per = per;
    const rw = parseFloat(block.reward); this.ref_reward = Number.isNaN(rw) ? this.ref_lifetime * per : rw;
    this._persist();
  }
  set_ref_wallet(wallet) { const w = String(wallet || '').replace(/\s+/g, '').slice(0, 64); this.ref_wallet = w; this._persist(); return { ok: true, wallet: w }; }
  static _wallet_looks_trc20(w) { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test((w || '').trim()); }
  async request_payout(wallet = '') {
    if (!(this.licensed && this.license_key)) return { ok: false, msg: this._t('lic_need') };
    const w = String(wallet || '').replace(/\s+/g, '') || this.ref_wallet || '';
    if (!Api._wallet_looks_trc20(w)) return { ok: false, msg: this._t('ref_wallet_bad') };
    if (w !== this.ref_wallet) this.set_ref_wallet(w);
    const resp = await this._server_post('/referral/payout', { key: this.license_key, machine: await this.get_machine_id(), product: 'mini', wallet: w });
    if (resp === null) return { ok: false, msg: this._t('lic_server_down') };
    if (resp.status !== 'ok') return { ok: false, msg: resp.msg || this._t('ref_payout_fail') };
    return { ok: true, amount: resp.amount, msg: resp.msg || '' };
  }
  async get_referral() {
    const key = this.license_key || '';
    if (!(this.licensed && key)) return { ok: false, licensed: false };
    const life = parseInt(this.ref_lifetime || 0) || 0; const per = parseFloat(this.ref_per || C['Api._REF_REWARD_USD']) || C['Api._REF_REWARD_USD'];
    return { ok: true, licensed: true, code: await referral_code(key), link: await referral_link(key), wallet: this.ref_wallet || '', count: parseInt(this.ref_count || 0) || 0, lifetime: life, per, reward: parseFloat(this.ref_reward ?? life * per) || 0 };
  }
  get_license_status() {
    if (!this.licensed) return { licensed: false };
    const act = this.license_activated || ''; const exp = this.license_expires || this._license_expiry(this.license_type, act);
    let days_left = null; if (exp) { const d = fromIso(exp); days_left = d ? Math.max(0, daysBetween(d, new Date())) : null; }
    return { licensed: true, type: this.license_type, key: this.license_key, activated: act, expires: exp, days_left };
  }
  async activate_license(key) {
    if (!this._consent_ok()) return { ok: false, need_consent: true, msg: this._t('consent_need') };
    key = (key || '').trim();
    const res = await this._validate_key(key);
    if (!res.ok) return { ok: false, licensed: this.licensed, reachable: res.reachable ?? true, msg: res.msg || this._t('lic_bad') };
    const ltype = res.type || 'lifetime'; const now_iso = isoNow(); const exp = this._license_expiry(ltype, now_iso);
    store.set(LIC_KEY, JSON.stringify({ key: key.toUpperCase(), type: ltype, activated: now_iso, expires: exp }));
    Object.assign(this, { license_key: key.toUpperCase(), license_type: ltype, license_activated: now_iso, license_expires: exp, licensed: true });
    return { ok: true, licensed: true };
  }
  open_buy_license() { webbrowser.open('https://videorils.com'); return true; }
  _consent_ok() { return this.consent_version === DOCS_VERSION; }
  get_consent() { return { accepted: this._consent_ok(), version: DOCS_VERSION, date: this.consent_date }; }
  async set_consent(accepted) {
    if (accepted) { this.consent_version = DOCS_VERSION; this.consent_date = strftime('%Y-%m-%d %H:%M:%S'); this.consent_machine = await this.get_machine_id(); }
    else { this.consent_version = ''; this.consent_date = ''; this.consent_machine = ''; }
    this._persist();
    return { ok: true, accepted: this._consent_ok() };
  }
  open_legal() { webbrowser.open('https://videorils.com/en/legal/'); return true; }
  open_gemini_trial() { webbrowser.open('https://aistudio.google.com/apikey'); return true; }

  // ── воронка ──
  async _funnel_id() {
    if (this._funnel_id_cache) return this._funnel_id_cache;
    const raw = await this.get_machine_id();
    this._funnel_id_cache = (await sha256Hex(C['Api._EV_SALT'] + '|' + raw)).slice(0, 32);
    return this._funnel_id_cache;
  }
  _first_launch_flag() { if (store.get(FIRST_KEY)) return false; store.set(FIRST_KEY, isoNow()); return true; }
  track(event, reason = '') {
    thread(async () => {
      try {
        const body = { install_id: await this._funnel_id(), event, app_version: APP_VERSION, edition: _EDITION + '_web', ts: isoNow() };
        if (reason) body.reason = String(reason).slice(0, 160);
        await requests.post(VR_SERVER_URL.replace(/\/+$/, '') + '/api/ev', { json: body, timeout: [5, 8] });
      } catch (e) { }
    });
  }
  track_open() { if (this._first_launch_flag()) this.track('first_launch'); this.track('app_open'); }

  // id компьютера (аналог MachineGuid): отпечаток ЖЕЛЕЗА + хранение в 3 местах браузера —
  // «один компьютер — одна лицензия», не слетает при очистке/смене браузера (machine.js)
  async get_machine_id() {
    if (this._machine_id) return this._machine_id;
    const { machineId } = await import('./machine.js');
    this._machine_id = await machineId('vrmini-machine|web');
    return this._machine_id;
  }

  // ── триал: 1 бесплатное видео (проверка на СЕРВЕРЕ) ──
  async _trial_used_local() { try { const d = JSON.parse(store.get(TRIAL_KEY) || 'null'); return !!(d && d.used) && d.mid === await this.get_machine_id(); } catch (e) { return false; } }
  async _cache_trial(used) { store.set(TRIAL_KEY, JSON.stringify({ mid: await this.get_machine_id(), used: !!used })); }
  async _trial_used() {
    const resp = await this._cf_post('/trial', { machine: await this.get_machine_id(), action: 'status', product: 'mini' });
    if (resp !== null && resp.status === 'ok') {
      this.promo_active = !!resp.promo_active; this.promo_code = resp.promo_code || ''; this.promo_days_left = parseInt(resp.promo_days_left || 0) || 0;
      const used = !(resp.trial_available ?? true);
      await this._cache_trial(used);
      return used;
    }
    return this._trial_used_local();
  }
  async _mark_trial_used() {
    await this._cf_post('/trial', { machine: await this.get_machine_id(), action: 'use', product: 'mini' });
    await this._cache_trial(true);
  }
  async activate_promo(code) {
    code = (code || '').trim().toUpperCase();
    if (!code) return { ok: false, msg: this._t('promo_need') };
    const resp = await this._server_post('/promo/activate', { machine: await this.get_machine_id(), code, product: 'mini' });
    if (resp === null) return { ok: false, msg: this._t('promo_offline') };
    if (resp.ok) {
      this.promo_active = true; this.promo_code = resp.promo_code || code; this.promo_days_left = parseInt(resp.promo_days_left || 0) || 0;
      log(`  🎟 промокод ${code}: доступ на ${this.promo_days_left} дн.`);
      return { ok: true, days: parseInt(resp.days || 3) || 3, days_left: this.promo_days_left, code: this.promo_code, expires: resp.promo_expires_at || '' };
    }
    return { ok: false, reason: resp.reason || '', msg: resp.msg || this._t('promo_fail') };
  }
  async start_trial() {
    if (!this._consent_ok()) return { ok: false, need_consent: true, msg: this._t('consent_need') };
    if (this.licensed) return { ok: true, already: true };
    if (await this._trial_used()) return { ok: false, used: true, msg: this._t('trial_used_msg') };
    this.trial_active = true;
    return { ok: true };
  }
  _maybe_revalidate() {
    if (!this.licensed || !this.license_key) return;
    const t = now();
    if (t - (this._lic_checked_at || 0) < C['Api._LIC_RECHECK_SEC']) return;
    this._lic_checked_at = t;
    thread(() => this._revalidate_license());
  }
  _has_access() { this._maybe_revalidate(); return this.licensed || this.promo_active || this.trial_active; }
  _license_mask() { const k = this.license_key || ''; const p = k.split('-'); return p.length >= 2 ? p[0] + '-…-' + p[p.length - 1] : k; }
  async get_plans() {
    try {
      const r = await requests.get(`${CF_URL}/product-plans`, { params: { product: 'mini' }, timeout: 10 });
      const data = Object.assign({}, r.json() || {}); const raw = data.plans || {};
      data.plans = {}; for (const [k, v] of Object.entries(raw)) data.plans[k] = (v && typeof v === 'object') ? v : { price: v };
      if (!data.web_plans) data.web_plans = WEB_PLANS_FB;
      return data;
    } catch (e) { return { plans: { monthly: { price: 15 }, yearly: { price: 79 }, lifetime: { price: 97 } }, web_plans: WEB_PLANS_FB }; }
  }
  async get_upgrade_price() {
    let out;
    try { const r = await requests.get(`${VR_SERVER_URL}/license/upgrade-price`, { params: { machine_id: await this.get_machine_id(), key: this.license_key || '' }, timeout: 12 }); out = Object.assign({}, r.json() || {}); }
    catch (e) { return { ok: false }; }
    const cur_type = this.license_type || '';
    if (['monthly', 'yearly'].includes(cur_type)) out.already_lifetime = false;
    try { const p = (await requests.get(`${CF_URL}/plans`, { timeout: 12 })).json() || {}; out.wallet = p.wallet || ''; out.network = p.network || 'TRC-20'; } catch (e) { }
    if (['monthly', 'yearly'].includes(cur_type)) {
      try {
        const rem = out.remaining_usdt;
        if (rem == null || parseFloat(rem) <= 0) {
          const life = parseFloat(out.lifetime_price ?? 97) || 97; const paid = cur_type === 'monthly' ? 15.0 : 79.0;
          const val = Math.max(life - paid, life * 0.3);
          out.remaining_usdt = val === Math.trunc(val) ? Math.trunc(val) : Math.round(val * 100) / 100;
        }
      } catch (e) { }
    }
    out.ok = true;
    return out;
  }
  async submit_upgrade(txid, amount) {
    const amt = parseFloat(amount); if (Number.isNaN(amt)) return { ok: false, msg: this._t('upgrade_bad_amount') };
    let res;
    try { const r = await requests.post(`${VR_SERVER_URL}/license/upgrade`, { json: { client: 'web', machine_id: await this.get_machine_id(), key: this.license_key || '', txid: (txid || '').trim(), amount: amt }, timeout: 40 }); res = Object.assign({}, r.json() || {}); }
    catch (e) { return { ok: false, msg: this._t('upgrade_net_err', String(e.message || e).slice(0, 60)) }; }
    if (res.status === 'ok' || res.plan === 'lifetime') {
      this.license_type = 'lifetime';
      try { const d = JSON.parse(store.get(LIC_KEY) || '{}'); d.type = 'lifetime'; store.set(LIC_KEY, JSON.stringify(d)); } catch (e) { }
      this._persist();
      return { ok: true, plan: 'lifetime', total_paid: res.total_paid };
    }
    return { ok: false, msg: res.msg || res.status || this._t('upgrade_unconfirmed') };
  }
  async get_access_status() {
    if (this.licensed) {
      const _act = this.license_activated || ''; let _exp = this.license_expires || '';
      if (!_exp) _exp = this._license_expiry(this.license_type || 'lifetime', _act);
      let _dl = null; if (_exp) { const d = fromIso(_exp); _dl = d ? Math.max(0, daysBetween(d, new Date())) : null; }
      return { licensed: true, trial_active: false, trial_used: false, trial_available: false, key_mask: this._license_mask(), key: this.license_key || '',
        key_type: this.license_type || 'lifetime', key_expires: _exp, key_activated: _act, key_days_left: _dl,
        promo_active: this.promo_active, promo_code: this.promo_code, promo_days_left: this.promo_days_left,
        consent_ok: this._consent_ok(), docs_version: DOCS_VERSION, machine_id: await this.get_machine_id() };
    }
    const used = await this._trial_used();
    return { licensed: false, trial_active: this.trial_active, trial_used: used, trial_available: !used,
      promo_active: this.promo_active, promo_code: this.promo_code, promo_days_left: this.promo_days_left,
      consent_ok: this._consent_ok(), docs_version: DOCS_VERSION, machine_id: await this.get_machine_id() };
  }
  async _active_pixabay_key() {
    const keys = this.pixabay_keys;
    if (keys && keys.length) return keys[Math.min(this._pix_key_idx || 0, keys.length - 1)];
    if (this.pixabay_key) return this.pixabay_key;
    if (!this.licensed) return await this._trial_media_key();
    return '';
  }
  _rotate_pixabay_key() {
    const keys = this.pixabay_keys || [];
    if (keys.length <= 1) return false;
    const nxt = (this._pix_key_idx || 0) + 1; if (nxt >= keys.length) return false;
    this._pix_key_idx = nxt; PIX.LIMIT_HIT = false;
    log(`  🔁 Media-ключ #${nxt + 1}/${keys.length} — пробую после лимита прошлого`);
    return true;
  }
  _key_source_label() {
    const keys = (this.pixabay_keys && this.pixabay_keys.length) ? this.pixabay_keys : (this.pixabay_key ? [this.pixabay_key] : []);
    if (keys.length) return keys.length > 1 ? `настройки (ключей: ${keys.length}, активен #${(this._pix_key_idx || 0) + 1})` : 'настройки-пользователя';
    if (!this.licensed) return 'сервер-триал';
    return 'нет-ключа';
  }
  _invalidate_media_caches() {
    this._pix_cand_cache = {}; this._scene_clip_cache = {}; this._cached_media_key = '';
    PIX.LIMITED = {}; PIX.LIMIT_HIT = false;
    try { for (const s of this.reel_scenes || []) { if (s.clip) continue; if (!(s.pick && s.pick.id)) { s.preview = ''; s.pick = null; } } } catch (e) { }
  }
  async _trial_media_key() {
    if (this._cached_media_key) return this._cached_media_key;
    const resp = await this._server_post('/trial-media-key', { machine: await this.get_machine_id() });
    if (resp && resp.status === 'ok' && resp.key) { this._cached_media_key = resp.key; return this._cached_media_key; }
    return '';
  }
  _norm_hex(s, dflt = '#0a1712') {
    s = (s || '').trim().replace(/^#+/, '');
    if (s.length === 3) s = [...s].map(c => c + c).join('');
    if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
    return dflt;
  }
  _outro_photo_exists() { return !!(this.outro_photo && this.outro_photo.startsWith('assets/user/')); }
  static _mask(key) { const k = key || ''; return k.length >= 4 ? '••••' + k.slice(-4) : '••••'; }
  ping() { return { ok: true, dir: 'web' }; }
  set_platform() { this.platform = 'reel'; return this.platform; }
  set_reel_seconds(n) { const v = parseInt(n); this.reel_seconds = Number.isNaN(v) ? 30 : Math.max(20, Math.min(40, v)); return this.reel_seconds; }
}
