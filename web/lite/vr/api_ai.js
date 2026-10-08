// Порт Api: AI-ключи, _ai_call/_claude_call/_gemini_call, квота Gemini, ошибки (app.py 7067–7981).
import { C, log, re, requests, webbrowser, sleep, now, store, sha1Hex, call_js, vfs, blobToDataUrl } from './core.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const AI_BASE = C['Api.AI_BASE'], AI_VERSION = C['Api.AI_VERSION'], AI_MODELS = C['Api.AI_MODELS'], AI_CHECK_MODEL = C['Api.AI_CHECK_MODEL'];
const GEMINI_BASE = C['Api.GEMINI_BASE'], GEMINI_CHAIN = C['Api.GEMINI_CHAIN'], _GEMINI_FALLBACK = C['Api._GEMINI_FALLBACK'], _GEM_SPAN = C['Api._GEM_SPAN'];
const QKEY = 'vr_lite_gem_quota';

// ── скользящее окно RPM на модель (_ai_throttle / _ai_set_rpm) ──
const _AI_TIMES = {}, _AI_MAX_PER_MIN = {}; let _aiChain = Promise.resolve();
export function _ai_set_rpm(mid, n) { const v = parseInt(n); if (!Number.isNaN(v)) _AI_MAX_PER_MIN[mid || ''] = Math.max(1, v - 1); }
export function _ai_throttle(mid = '') {
  const p = _aiChain.then(async () => {
    const times = (_AI_TIMES[mid] = _AI_TIMES[mid] || []);
    const cap = _AI_MAX_PER_MIN[mid] ?? C._AI_RPM_DEFAULT;
    let t = now(); while (times.length && times[0] < t - 60) times.shift();
    if (times.length >= cap) {
      const wait = 60.0 - (t - times[0]) + 0.25; if (wait > 0) await sleep(wait);
      t = now(); while (times.length && times[0] < t - 60) times.shift();
    }
    times.push(now());
  });
  _aiChain = p.catch(() => { });
  return p;
}

P._ai_model_id = function () { return AI_MODELS[this.ai_model] || AI_MODELS.sonnet; };
P.set_ai_model = function (which) { this.ai_model = which in AI_MODELS ? which : 'sonnet'; this.ai_provider = 'claude'; this._persist(); return { ok: true, model: this.ai_model, provider: this.ai_provider }; };
P.open_anthropic_signup = function () { webbrowser.open('https://console.anthropic.com/settings/keys'); return true; };
P.open_anthropic_billing = function () { webbrowser.open('https://platform.claude.com/settings/billing'); return true; };
P.get_ai_key_status = function () { return { has: !!this.claude_key, mask: this.claude_key ? Api._mask(this.claude_key) : '', model: this.ai_model }; };
P.check_ai_key = async function (key = null) {
  key = (key || this.claude_key || '').trim();
  if (!key) return { ok: false, state: 'none', msg: this._t('ai_no_key') };
  if (!this._key_ascii_ok(key)) return { ok: false, state: 'bad_key', msg: this._t('ai_bad_key') };
  const [ok, msg] = await this._claude_call('Ответь одним словом: привет', key, 16, AI_CHECK_MODEL);
  if (ok) return { ok: true, state: 'ok' };
  const sc = this._ai_last_status;
  if (sc === 401 || sc === 403) return { ok: false, state: 'bad_key', msg };
  const low = (msg || '').toLowerCase();
  if (sc === 400 && (low.includes('balance') || low.includes('funds') || low.includes('credit'))) return { ok: false, state: 'no_funds', msg };
  return { ok: false, state: 'error', msg };
};
P._cla_keys_view = function () { return this.claude_keys.map(k => ({ mask: Api._mask(k) })); };
P.get_claude_masks = function () { return { keys: this.claude_keys.map(k => ({ mask: Api._mask(k), status: 'checking' })), max: 5 }; };
P.get_claude_keys = async function () { const out = []; for (const k of this.claude_keys) { const c = await this.check_ai_key(k); out.push({ mask: Api._mask(k), ok: c.ok ?? true, state: c.state || 'ok' }); } return { keys: out, max: 5 }; };
P.add_claude_key = async function (key) {
  this.track('keys_saved');
  key = (key || '').trim();
  if (!key) return { ok: false, msg: this._t('key_enter'), keys: this._cla_keys_view() };
  if (this.claude_keys.length >= 5) return { ok: false, msg: this._t('max_5_keys'), keys: this._cla_keys_view() };
  if (this.claude_keys.includes(key)) return { ok: false, msg: this._t('key_already_added'), keys: this._cla_keys_view() };
  this.claude_keys.push(key); this._persist();
  const chk = await this.check_ai_key(key);
  return { ok: true, has: true, mask: Api._mask(key), state: chk.state || 'ok', msg: chk.msg, keys: this._cla_keys_view() };
};
P.remove_claude_key = function (idx = 0) { const i = parseInt(idx); if (!Number.isNaN(i) && i >= 0 && i < this.claude_keys.length) { this.claude_keys.splice(i, 1); this.claude_idx = 0; this._persist(); } return { ok: true, has: !!this.claude_keys.length, keys: this._cla_keys_view() }; };
P.set_claude_key = function (key) { return this.add_claude_key(key); };
P.set_ai_provider = function (which) { this.ai_provider = ['claude', 'gemini'].includes(which) ? which : 'claude'; this._persist(); return { ok: true, provider: this.ai_provider }; };
P.get_ai_providers = function () { return { provider: this.ai_provider, has_claude: !!this.claude_key, has_gemini: !!this.gemini_key }; };
P.get_ai_choice = function () { if (this.ai_provider === 'gemini') return 'free'; return this.ai_model === 'opus' ? 'smart' : 'fast'; };
P.set_ai_choice = function (choice) {
  if (choice === 'free') this.ai_provider = 'gemini';
  else if (choice === 'smart') { this.ai_provider = 'claude'; this.ai_model = 'opus'; }
  else { this.ai_provider = 'claude'; this.ai_model = 'sonnet'; }
  this._persist(); return { ok: true, choice: this.get_ai_choice() };
};
P.get_reel_ai = function () { return { choice: this.get_ai_choice(), has_claude: !!this.claude_key, has_gemini: !!this.gemini_key }; };
P.open_gemini_signup = function () { webbrowser.open('https://aistudio.google.com/apikey'); return true; };
P.get_gemini_key_status = function () { return { has: !!this.gemini_key, mask: this.gemini_key ? Api._mask(this.gemini_key) : '', model: this.gemini_model }; };
P.check_gemini_key = async function (key = null) {
  key = (key || this.gemini_key || '').trim();
  if (!key) return { ok: false, state: 'none', msg: this._t('gem_no_key') };
  if (!this._key_ascii_ok(key)) return { ok: false, state: 'bad_key', msg: this._t('gem_bad_key') };
  const [ok, msg] = await this._gemini_call('Ответь одним словом: привет', key, 300);
  const sc = this._ai_last_status;
  if (ok || sc === 200) return { ok: true, state: 'ok' };
  if (sc === 429) return { ok: false, state: 'no_funds', msg };   // ключ рабочий, дневной лимит
  if (sc === 401 || sc === 403) return { ok: false, state: 'restricted', msg };
  if (sc === 0) return { ok: false, state: 'bad_key', msg: this._t('gem_no_connection') };
  return { ok: false, state: 'bad_key', msg };
};
P._gem_keys_view = function () { return this.gemini_keys.map(k => ({ mask: Api._mask(k) })); };
P.get_gemini_masks = function () { return { keys: this.gemini_keys.map(k => ({ mask: Api._mask(k), status: 'checking' })), max: 5 }; };
P.get_gemini_keys = async function () { const out = []; for (const k of this.gemini_keys) { const c = await this.check_gemini_key(k); out.push({ mask: Api._mask(k), ok: c.ok ?? true, state: c.state || 'ok' }); } return { keys: out, max: 5 }; };
P.add_gemini_key = async function (key) {
  this.track('keys_saved');
  key = (key || '').trim();
  if (!key) return { ok: false, msg: this._t('key_enter'), keys: this._gem_keys_view() };
  if (this.gemini_keys.length >= 5) return { ok: false, msg: this._t('max_5_keys'), keys: this._gem_keys_view() };
  if (this.gemini_keys.includes(key)) return { ok: false, msg: this._t('key_already_added'), keys: this._gem_keys_view() };
  this.gemini_keys.push(key); this._persist();
  const chk = await this.check_gemini_key(key);
  return { ok: true, has: true, mask: Api._mask(key), state: chk.state || 'ok', msg: chk.msg, keys: this._gem_keys_view() };
};
P.remove_gemini_key = function (idx = 0) { const i = parseInt(idx); if (!Number.isNaN(i) && i >= 0 && i < this.gemini_keys.length) { this.gemini_keys.splice(i, 1); this.gemini_idx = 0; this._persist(); } return { ok: true, has: !!this.gemini_keys.length, keys: this._gem_keys_view() }; };
P.set_gemini_key = function (key) { return this.add_gemini_key(key); };
P._is_ai_limit = function (msg) { return !!msg && [this._t('gem_rate'), this._t('gem_rate_min'), this._t('gem_rate_day'), this._t('gem_zero')].includes(msg); };
P._notify_ai_limit = function () { try { call_js('aiLimitAsk', { has_paid: !!this.claude_key, reason: this._ai_last_reason || '', retry: parseInt(this._ai_last_retry || 0) || 0 }); } catch (e) { } };

P._ai_call = async function (prompt, key = null, max_tokens = 4000, model = null, provider = null, images = null) {
  this._ai_last_reason = '';
  provider = provider || this.ai_provider;
  if (provider === 'claude' && !(key || this.claude_key) && this.gemini_key) provider = 'gemini';
  else if (provider === 'gemini' && !(key || this.gemini_key) && this.claude_key) provider = 'claude';
  if (provider === 'gemini') return await this._gemini_call(prompt, key, max_tokens, model, images);
  return await this._claude_call(prompt, key, max_tokens, model);
};
P._claude_call = async function (prompt, key = null, max_tokens = 4000, model = null) {
  if (key) return await this._claude_call_one(prompt, key, max_tokens, model);
  const keys = this.claude_keys || [];
  if (!keys.length) return await this._claude_call_one(prompt, null, max_tokens, model);
  const n = keys.length, start = this.claude_idx % n; let last = [false, this._t('ai_no_key')];
  for (let off = 0; off < n; off++) {
    this.claude_idx = (start + off) % n;
    const [ok, out] = await this._claude_call_one(prompt, null, max_tokens, model);
    if (ok) return [ok, out];
    last = [ok, out];
    if (this._ai_last_status === 0 && !this._is_ai_limit(out)) break;
    if (off < n - 1) log(`  ↩ Claude ключ #${(start + off) % n + 1}/${n} не сработал — пробую следующий`);
  }
  return last;
};
P._claude_call_one = async function (prompt, key = null, max_tokens = 4000, model = null) {
  key = key || this.claude_key; this._ai_last_status = 0;
  if (!key) return [false, this._t('ai_no_key')];
  const mid = model || this._ai_model_id();
  const body = { model: mid, max_tokens, messages: [{ role: 'user', content: prompt }] };
  if (!mid.startsWith('claude-opus-4-8')) body.temperature = 0.95;
  let r;
  try {
    // браузер: Anthropic требует явного согласия на прямой вызов из браузера
    r = await requests.post(AI_BASE, { headers: { 'x-api-key': key, 'anthropic-version': AI_VERSION, 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' }, json: body, timeout: 180 });
  } catch (e) { log(`  ⚠ Anthropic сеть: ${String(e.message || e).slice(0, 140)}`); return [false, this._t('ai_network')]; }
  this._ai_last_status = r.status_code;
  if (r.status_code === 200) {
    try {
      const text = ((r.json().content) || []).filter(p => p.type === 'text').map(p => p.text || '').join('').trim();
      if (!text) return [false, this._t('ai_empty')];
      return [true, text];
    } catch (e) { return [false, this._t('ai_bad_response', String(e.message || e).slice(0, 140))]; }
  }
  let _em; try { const _e = r.json().error || {}; _em = _e.message || (r.text || '').slice(0, 200); } catch (e) { _em = (r.text || '').slice(0, 200); }
  log(`  ✖ Claude ${r.status_code} (model=${model || this._ai_model_id()}): ${_em}`);
  return [false, this._ai_error_msg(r)];
};

// ── квота Gemini (gem_quota.json -> localStorage) ──
P._gem_dead_map = function () { const c = this._gem_cache(); let d = c._dead; if (!d || typeof d !== 'object') { d = {}; c._dead = d; } return d; };
P._gem_model_alive = function (mid) { const ts = parseFloat(this._gem_dead_map()[mid] || 0) || 0; return !(ts && (now() - ts) < _GEM_SPAN.day); };
P._gem_mark_dead = function (mid) { try { this._gem_dead_map()[mid] = now(); this._gem_quota_save(); } catch (e) { } };
P._gem_chain = function () {
  let alive = GEMINI_CHAIN.filter(m => this._gem_model_alive(m));
  if (!alive.length) alive = [...GEMINI_CHAIN];
  if (_GEMINI_FALLBACK && !alive.includes(_GEMINI_FALLBACK)) alive.push(_GEMINI_FALLBACK);
  return alive;
};
P._gemini_model_id = function () { return this._gem_chain()[0]; };
P._gem_qkey = function (mid = null) {
  const k = (this.gemini_key || '').trim(); if (!k) return '';
  // локальный учёт: стабильный синхронный хеш ключа (FNV-1a 64) вместо sha1
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < k.length; i++) { const c = k.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12) + '|' + (mid || this._gemini_model_id());
};
Api._gem_blank_rec = function () { return { sent: 0, reels: 0, reel_reqs: 0, zero: false, windows: { min: { limit: null, count: 0, t: 0.0 }, day: { limit: null, count: 0, t: 0.0 } } }; };
P._gem_migrate = function () { const c = this._gem_quota_cache; if (c._v === 4) return; c._v = 4; };
P._gem_cache = function () {
  if (!this._gem_quota_cache) { try { this._gem_quota_cache = JSON.parse(store.get(QKEY) || '{}') || {}; } catch (e) { this._gem_quota_cache = {}; } this._gem_migrate(); }
  return this._gem_quota_cache;
};
P._gem_rec = function (mid = null) {
  this._gem_cache(); const qk = this._gem_qkey(mid); if (!qk) return null;
  let rec = this._gem_quota_cache[qk];
  if (!rec || typeof rec !== 'object' || !rec.windows) { rec = Api._gem_blank_rec(); this._gem_quota_cache[qk] = rec; }
  return rec;
};
P._gem_roll = function (rec) { const t0 = now(); for (const [wk, span] of Object.entries(_GEM_SPAN)) { const w = rec.windows[wk]; const t = w.t || 0; if (t && t0 - t >= span) { w.count = 0; w.t = t0; } } return t0; };
P._gem_quota_save = function () { try { store.set(QKEY, JSON.stringify(this._gem_quota_cache || {})); } catch (e) { } };
P._gem_note_request = function (mid = null) {
  try {
    const rec = this._gem_rec(mid); if (!rec) return;
    const t = this._gem_roll(rec); rec.sent = (parseInt(rec.sent || 0) || 0) + 1;
    for (const wk of ['min', 'day']) {
      const w = rec.windows[wk]; const lim = w.limit;
      if (lim && (parseInt(w.count || 0) || 0) >= lim) { w.count = 0; w.t = t; }
      if (!w.t) w.t = t;
      w.count = (parseInt(w.count || 0) || 0) + 1;
    }
    this._gem_quota_save();
  } catch (e) { }
};
P._gem_note_limit = function (err, blob = '', mid = null) {
  try {
    const found = {};
    for (const d of ((err || {}).details || [])) for (const v of (d.violations || [])) {
      const qid = (v.quotaId || '').toLowerCase();
      const wk = qid.includes('perminute') ? 'min' : (qid.includes('perday') ? 'day' : null);
      let lim = null; if (v.quotaValue != null) { const x = parseInt(String(v.quotaValue)); lim = Number.isNaN(x) ? null : x; }
      if (wk && lim !== null) found[wk] = lim;
    }
    if (!Object.keys(found).length) {
      const m = /limit:\s*(\d+)/.exec(blob || '');
      if (m) {
        const b = (blob || '').toLowerCase();
        const wk = ['perminute', 'per minute', 'requestspermin'].some(s => b.includes(s)) ? 'min' : (['perday', 'per day', 'requestsperday', 'daily'].some(s => b.includes(s)) ? 'day' : null);
        if (wk) found[wk] = parseInt(m[1]);
      }
    }
    if (!Object.keys(found).length) return false;
    const rec = this._gem_rec(mid); if (!rec) return 'day' in found;
    this._gem_roll(rec);
    for (const [wk, lim] of Object.entries(found)) {
      rec.windows[wk].limit = lim;
      if (lim === 0) rec.zero = true;
      else if (lim > 0) { const w = rec.windows[wk]; if (!w.t) w.t = now(); w.count = Math.max(parseInt(w.count || 0) || 0, lim); if (wk === 'min') _ai_set_rpm(mid || this._gemini_model_id(), lim); }
    }
    if ('day' in found && mid) this._gem_mark_dead(mid);
    this._gem_quota_save();
    return 'day' in found;
  } catch (e) { return false; }
};
P._gem_reel_begin = function () { try { const rec = this._gem_rec(); this._gem_reel_snap = rec ? (parseInt(rec.sent || 0) || 0) : null; } catch (e) { this._gem_reel_snap = null; } };
P._gem_reel_end = function () {
  try {
    const rec = this._gem_rec(); const snap = this._gem_reel_snap; this._gem_reel_snap = null;
    if (!rec || snap == null) return;
    const delta = Math.max(0, (parseInt(rec.sent || 0) || 0) - snap);
    if (delta > 0) { rec.reels = (parseInt(rec.reels || 0) || 0) + 1; rec.reel_reqs = (parseInt(rec.reel_reqs || 0) || 0) + delta; this._gem_quota_save(); }
  } catch (e) { }
};
P._gem_avg_per_reel = function (rec) { const reels = parseInt(rec.reels || 0) || 0, reqs = parseInt(rec.reel_reqs || 0) || 0; return (reels > 0 && reqs > 0) ? Math.max(1.0, reqs / reels) : 2.0; };
P.get_gem_quota = function () {
  try {
    if (!this.gemini_key) return { ok: false };
    const rec = this._gem_rec(); if (!rec) return { ok: false };
    const t0 = this._gem_roll(rec); this._gem_quota_save();
    const win_out = (wk) => {
      const w = rec.windows[wk]; const lim = w.limit; const cnt = parseInt(w.count || 0) || 0; const t = w.t || 0;
      const o = { limit: lim, used: lim ? Math.min(cnt, lim) : cnt };
      if (lim) o.left = Math.max(0, lim - cnt);
      o.reset = t ? Math.max(0, Math.trunc(_GEM_SPAN[wk] - (t0 - t))) : null;
      return o;
    };
    const mn = win_out('min'), dy = win_out('day'); const avg = this._gem_avg_per_reel(rec);
    const out = { ok: true, model: this._gemini_model_id(), sent: parseInt(rec.sent || 0) || 0, zero: !!rec.zero, avg_per_reel: Math.round(avg * 10) / 10, min: mn, day: dy };
    const lefts = [mn, dy].filter(w => w.left != null).map(w => w.left);
    if (lefts.length && avg > 0) out.reels_left = Math.floor(Math.min(...lefts) / avg);
    const dt0 = rec.windows.day.t || 0;
    if (dt0) { const d = new Date((dt0 + 86400) * 1000); out.day_reset_clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
    return out;
  } catch (e) { return { ok: false }; }
};

P._gemini_call = async function (prompt, key = null, max_tokens = 4000, model = null, images = null) {
  if (key) return await this._gemini_call_one(prompt, key, max_tokens, model, images);
  const keys = this.gemini_keys || [];
  if (!keys.length) return await this._gemini_call_one(prompt, null, max_tokens, model, images);
  const n = keys.length, start = this.gemini_idx % n; let last = [false, this._t('gem_no_key')];
  for (let off = 0; off < n; off++) {
    this.gemini_idx = (start + off) % n;
    const [ok, out] = await this._gemini_call_one(prompt, null, max_tokens, model, images);
    if (ok) return [ok, out];
    last = [ok, out];
    if (this._ai_last_status === 0 && !this._is_ai_limit(out)) break;
    if (off < n - 1) log(`  ↩ Gemini ключ #${(start + off) % n + 1}/${n} не сработал — пробую следующий`);
  }
  return last;
};
P._gemini_call_one = async function (prompt, key = null, max_tokens = 4000, model = null, images = null) {
  key = key || this.gemini_key; this._ai_last_status = 0;
  if (!key) return [false, this._t('gem_no_key')];
  // images — пути к JPEG (кадры ролика для Автомонтажа) -> inline_data base64
  const parts = [{ text: prompt }];
  for (const p of (images || [])) {
    try { const b = vfs.read(p); if (!b) throw new Error('нет файла'); const d = await blobToDataUrl(b); parts.push({ inline_data: { mime_type: 'image/jpeg', data: String(d).split(',')[1] } }); }
    catch (e) { log(`  ⚠ кадр для ИИ не прочитан (${String(p).split('/').pop()}): ${String(e.message || e).slice(0, 40)}`); }
  }
  const body = { contents: [{ parts }], generationConfig: { temperature: 0.95, maxOutputTokens: Math.max(64, parseInt(max_tokens)), thinkingConfig: { thinkingBudget: 0 } } };
  const headers_try = [{ 'x-goog-api-key': key, 'Content-Type': 'application/json' }, { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }];
  let mids = model ? [model] : this._gem_chain();
  const seen = new Set(); mids = mids.filter(m => m && !seen.has(m) && seen.add(m));
  let r = null; let last_mid = mids[0] || '';
  for (let _mi = 0; _mi < mids.length; _mi++) {
    const mid = mids[_mi]; last_mid = mid;
    const url = GEMINI_BASE + mid + ':generateContent';
    await _ai_throttle(mid);
    let body_m = body;
    if (!mid.startsWith('gemini-2.')) { const gc = Object.assign({}, body.generationConfig); delete gc.thinkingConfig; body_m = { contents: body.contents, generationConfig: gc }; }
    let got404 = false, perday = false, bad400 = false;
    for (let _retry = 0; _retry < 2; _retry++) {
      let cont = false;
      for (let hi = 0; hi < headers_try.length; hi++) {
        try { r = await requests.post(url, { headers: headers_try[hi], json: body_m, timeout: 180 }); }
        catch (e) { log(`  ⚠ Gemini сеть: ${String(e.message || e).slice(0, 140)}`); return [false, this._t('ai_network')]; }
        this._ai_last_status = r.status_code;
        this._log_gem_call(prompt, mid, r.status_code, _retry);
        if (r.status_code === 200) { this._gem_note_request(mid); return this._gemini_extract(r); }
        if (hi === 0 && (r.status_code === 401 || r.status_code === 403)) continue;
        break;
      }
      if (r && r.status_code === 404) { got404 = true; break; }
      if (r && r.status_code === 400) { bad400 = true; break; }
      if (r && r.status_code === 429) {
        perday = this._gem_learn_429(r, mid);
        if (perday) break;
        if (_retry === 0) {
          const rd = this._gemini_retry_delay(r);
          if (rd > 0 && rd <= 30) { log(`  ⏳ Gemini 429 (минутный лимит ${mid}) — пауза ${rd.toFixed(0)}с и повтор`); await sleep(rd + 0.3); await _ai_throttle(mid); cont = true; }
        }
      }
      if (!cont) break;
    }
    if ((got404 || perday || bad400) && _mi < mids.length - 1) {
      const why = got404 ? 'недоступна (404)' : (perday ? 'исчерпана на сегодня (лимит/сутки)' : 'отвергла запрос (400)');
      log(`  ↩ модель ${mid} ${why} — переключаюсь на ${mids[_mi + 1]}`);
      continue;
    }
    break;
  }
  return [false, this._gemini_error_msg(r, last_mid)];
};
P._gem_learn_429 = function (r, mid) {
  let err = {}; try { err = (r.json() || {}).error || {}; } catch (e) { }
  let blob = ((err.message || '') + ' ' + (err.status || '')).toLowerCase();
  if (!blob.trim()) blob = (r.text || '').slice(0, 400).toLowerCase();
  this._log_gem_429(r);
  return !!this._gem_note_limit(err, blob, mid);
};
P._gemini_retry_delay = function (r) {
  try { for (const d of (((r.json() || {}).error || {}).details || [])) { if (d.retryDelay) { const m = /([\d.]+)/.exec(String(d.retryDelay)); if (m) return parseFloat(m[1]); } } } catch (e) { }
  return 0.0;
};
P._gemini_extract = function (r) {
  let data; try { data = r.json(); } catch (e) { return [false, this._t('ai_bad_response', String(e.message || e).slice(0, 140))]; }
  const cand = data.candidates || [];
  if (cand.length) {
    const parts = ((cand[0].content || {}).parts) || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (text) return [true, text];
    const fr = cand[0].finishReason || '';
    if (fr && !['STOP', 'FINISH_REASON_STOP'].includes(fr)) return [false, this._t('gem_finish', fr)];
  }
  const pf = data.promptFeedback || {};
  if (pf.blockReason) return [false, this._t('gem_blocked', pf.blockReason)];
  return [false, this._t('ai_empty')];
};
P._gemini_error_msg = function (r) {
  this._ai_last_reason = '';
  if (!r) return this._t('ai_http', 0, 'no response');
  let detail = '', status = '', err = {};
  try { err = r.json().error || {}; detail = err.message || ''; status = err.status || ''; } catch (e) { detail = (r.text || '').slice(0, 200); }
  const sc = r.status_code; const low = (detail + ' ' + status).toLowerCase();
  const safe = (detail || status || '').slice(0, 160).replace(/\{/g, '(').replace(/\}/g, ')');
  if (sc === 400 && low.includes('api key not valid')) return this._t('gem_bad_key');
  if (sc === 401) return this._t('gem_bad_key');
  if (sc === 403) return this._t('gem_restricted', safe);
  if (sc === 429) {
    let blob = low; try { for (const d of (err.details || [])) blob += ' ' + JSON.stringify(d).toLowerCase(); } catch (e) { }
    this._ai_last_retry = Math.trunc(this._gemini_retry_delay(r) || 0);
    if ((blob.includes('limit: 0') || blob.includes('limit:0') || blob.includes('"limit": 0')) && (blob.includes('free_tier') || blob.includes('free tier') || blob.includes('freetier'))) { this._ai_last_reason = 'gem_zero'; return this._t('gem_zero'); }
    const per_min = ['per minute', 'perminute', 'permin', 'per-minute', 'requests per minute', 'requestspermin'].some(s => blob.includes(s));
    const per_day = ['per day', 'perday', 'per-day', 'requests per day', 'requestsperday', 'daily'].some(s => blob.includes(s));
    if (per_min && !per_day) { this._ai_last_reason = 'gem_min'; return this._t('gem_rate_min'); }
    this._ai_last_reason = 'gem_day'; return this._t('gem_rate_day');
  }
  if ([500, 502, 503, 504, 529].includes(sc)) { log(`  ⚠ Gemini ${sc}: ${safe}`); return this._t('ai_overloaded'); }
  log(`  ⚠ Gemini ${sc}: ${safe}`);
  return this._t('gem_http', sc);
};
P._ai_error_msg = function (r) {
  let detail = '', etype = '';
  try { const err = r.json().error || {}; detail = err.message || ''; etype = err.type || ''; } catch (e) { detail = (r.text || '').slice(0, 200); }
  const sc = r.status_code; const low = (detail + ' ' + etype).toLowerCase();
  const safe = (detail || etype || '').slice(0, 200).replace(/\{/g, '(').replace(/\}/g, ')');
  if ((sc === 401 || sc === 403) && !low.includes('model')) return this._t('ai_bad_key');
  if (sc === 400 && (low.includes('credit') || low.includes('balance') || low.includes('funds'))) return this._t('ai_no_funds');
  if (low.includes('model') && [400, 403, 404].includes(sc) && ['not_found', 'not found', 'does not exist', 'unavailable', 'not available', 'permission', 'access', 'invalid'].some(s => low.includes(s))) return this._t('ai_model_unavailable', safe);
  if (sc === 429) return this._t('ai_rate');
  if ([500, 502, 503, 504, 529].includes(sc)) { log(`  ⚠ Anthropic ${sc}: ${safe}`); return this._t('ai_overloaded'); }
  log(`  ⚠ Anthropic ${sc}: ${safe}`);
  return this._t('ai_http', sc);
};
P._stress_merge_suffix = function () {
  if (!(this.tts_engine === 'eleven' && this.el_pronounce)) return '';
  return '\n\nИ ЕЩЁ (для озвучки — это ЕДИНСТВЕННОЕ дополнение к формату выше): ПОСЛЕ строк DESC| и TAGS| добавь по одной строке на КАЖДУЮ фразу В ТОМ ЖЕ ПОРЯДКЕ:\nУД|номер|та же фраза с проставленными ударениями (+ сразу после ударной гласной), числа и символы прописью, латиница под произношение. НЕ меняй слова и смысл — только разметка. Пример: УД|1|прив+ет, как дел+а.';
};
Api._topic_words = function (text) { return new Set(re.findall('[а-яёa-z]{5,}', (text || '').toLowerCase())); };
P._topic_matches = function (src, gen) { const a = Api._topic_words(src), b = Api._topic_words(gen); if (!a.size || !b.size) return true; let n = 0; for (const x of a) if (b.has(x)) n++; return n >= 2; };

// сколько запросов Gemini осталось СЕГОДНЯ (по всей цепочке живых моделей или по одной)
P._gem_day_left = function (model = null) {
  try {
    if (!this.gemini_key || this.ai_provider !== 'gemini') return null;
    const mids = model ? [model] : GEMINI_CHAIN.filter(m => this._gem_model_alive(m));
    let total = 0;
    for (const m of mids) {
      const rec = this._gem_rec(m); if (!rec) continue;
      this._gem_roll(rec);
      const w = rec.windows.day; const lim = w.limit;
      if (!lim) total += C['Api._GEM_FREE_RPD_GUESS'];
      else total += Math.max(0, parseInt(lim) - parseInt(w.count || 0));
    }
    return total;
  } catch (e) { return null; }
};
// перед пакетом: предупредить, сколько роликов влезет в дневную бесплатную квоту
P._gem_batch_preflight = function (n_reels) {
  try {
    const left = this._gem_day_left(); if (left === null) return;
    const rec = this._gem_rec();
    const avg = Math.max(3.0, rec ? this._gem_avg_per_reel(rec) : 3.0);
    const fits = Math.trunc(left / Math.max(1.0, avg));
    const alive = GEMINI_CHAIN.filter(m => this._gem_model_alive(m));
    log(`▶ Бесплатный Gemini: ~${left} запросов на сегодня по цепочке из ${alive.length} моделей (${alive.join(', ') || '—'}), ~${avg.toFixed(1)} запроса на ролик → хватит примерно на ${fits} из ${n_reels} роликов пакета`);
    if (fits < n_reels) this._degrade(`Дневной лимит бесплатного Gemini: из ${n_reels} роликов пакета сегодня реально соберётся ~${fits}. Остальные упрутся в лимит Google (20 запросов/сутки НА КАЖДУЮ модель, модели перебираются автоматически)`);
  } catch (e) { }
};
