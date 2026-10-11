// Groq (бесплатный ИИ для текста) + галочка «Наши ключи».
// Свой ключ Groq — напрямую в api.groq.com (CORS открыт). Без своего ключа и с галочкой «Наши ключи» —
// наш общий Groq через Worker (ключи там, в браузер не попадают). Модели — как в ботах: текущая,
// упёрлись в лимит/ошибку — следующая (и дальше остаёмся на ней).
import { log, requests, store, CF_URL, STOCK, enc_secret, dec_secret, webbrowser } from './core.js';
import { Api } from './api_base.js';
const P = Api.prototype;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = [
  ['openai/gpt-oss-120b', { reasoning_effort: 'low', include_reasoning: false }],
  ['qwen/qwen3.8-27b', { reasoning_effort: 'none' }],
  ['openai/gpt-oss-20b', { reasoning_effort: 'low', include_reasoning: false }],
];
let _groqModel = 0;

// ---------- галочка «Наши ключи» ----------
P._shared_store_key = function () { return `vr_${this._prod_id()}_use_shared`; };
P._prod_id = function () { return this._PROD || 'app'; };
P._shared_ready = function () { return !!(STOCK.pexels || STOCK.pixabay || STOCK.groq); };
P._use_shared = function () { let v = null; try { v = store.get(this._shared_store_key()); } catch (e) { } return v !== '0' && this._shared_ready(); };   // галочка «Наши ключи»
P.set_use_shared = function (on) { store.set(this._shared_store_key(), on ? '1' : '0'); this._media_chain_obj = null; try { this._invalidate_media_caches(); } catch (e) { } return this.get_shared_state(); };
P.get_shared_state = function () { const q = this.get_hour_quota ? this.get_hour_quota() : {}; return Object.assign({ on: this._use_shared(), ready: this._shared_ready(), groq_shared: !!STOCK.groq }, q, this._shared_limits()); };

// ---------- ключи Groq (до 5, хранятся локально зашифрованными) ----------
P._groq_store_key = function () { return `vr_${this._prod_id()}_groq_keys`; };
P._groq_keys_load = function () { if (this._groq_keys) return this._groq_keys; let l = []; try { l = JSON.parse(store.get(this._groq_store_key()) || '[]').map(dec_secret).filter(Boolean); } catch (e) { } this._groq_keys = l.slice(0, 5); return this._groq_keys; };
P._groq_keys_save = function () { store.set(this._groq_store_key(), JSON.stringify(this._groq_keys_load().map(enc_secret))); };
Object.defineProperty(P, 'groq_key', { get() { const l = this._groq_keys_load(); return l.length ? l[0] : ''; }, configurable: true });
P._groq_available = function () { return !!this.groq_key || (this._use_shared() && !!STOCK.groq); };
P._groq_check = async function (key) {
  try {
    const r = await requests.post(GROQ_URL, { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, json: { model: GROQ_MODELS[0][0], messages: [{ role: 'user', content: 'ok' }], max_tokens: 16, ...GROQ_MODELS[0][1] }, timeout: 20 });
    if (r.status_code === 200 || r.status_code === 429) return [true, r.status_code];
    return [false, r.status_code];
  } catch (e) { return [false, 0]; }
};
P.get_groq_keys = function () { return { keys: this._groq_keys_load().map(k => ({ mask: Api._mask(k) })), max: 5 }; };
P.add_groq_key = async function (key) {
  key = (this._clean_key ? this._clean_key(key) : String(key || '').trim());
  const l = this._groq_keys_load();
  if (!key) return { ok: false, msg: 'Вставьте ключ Groq', ...this.get_groq_keys() };
  if (!/^gsk_/.test(key)) return { ok: false, msg: 'Это не похоже на ключ Groq (он начинается с gsk_)', ...this.get_groq_keys() };
  if (l.includes(key)) return { ok: false, msg: 'Этот ключ уже добавлен', ...this.get_groq_keys() };
  if (l.length >= 5) return { ok: false, msg: 'Максимум 5 ключей', ...this.get_groq_keys() };
  const [ok, http] = await this._groq_check(key);
  if (!ok) return { ok: false, msg: http === 401 ? 'Ключ Groq неверный' : 'Не удалось проверить ключ — проверьте интернет', ...this.get_groq_keys() };
  l.push(key); this._groq_keys_save();
  return { ok: true, msg: '✅ Ключ Groq работает, сохранён', ...this.get_groq_keys() };
};
P.remove_groq_key = function (idx = 0) { const l = this._groq_keys_load(), i = parseInt(idx); if (i >= 0 && i < l.length) { l.splice(i, 1); this._groq_keys_save(); } return this.get_groq_keys(); };
P.open_groq_signup = function () { webbrowser.open('https://console.groq.com/keys'); return true; };

// ---------- вызов Groq ----------
P._groq_call = async function (prompt, max_tokens = 4000, prefer = 'groq') {
  const messages = [{ role: 'user', content: prompt }];
  const own = this._groq_keys_load();
  const pick = (j) => { const t = ((((j || {}).choices || [])[0] || {}).message || {}).content || ''; return String(t).trim(); };
  if (own.length && prefer !== 'gemini') {     // свои ключи: модель за моделью, ключ за ключом
    for (let n = 0; n < own.length * GROQ_MODELS.length; n++) {
      const mi = (_groqModel + n) % GROQ_MODELS.length, key = own[Math.floor(n / GROQ_MODELS.length) % own.length], [model, extra] = GROQ_MODELS[mi];
      let r; try { r = await requests.post(GROQ_URL, { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, json: { model, messages, max_tokens: Math.min(max_tokens, 8000), temperature: 0.9, ...extra }, timeout: 120 }); }
      catch (e) { log(`  ⚠ Groq сеть: ${String(e.message || e).slice(0, 80)}`); continue; }
      if (r.status_code === 200) { const t = pick(r.json()); if (t) { _groqModel = mi; log('  🤖 ИИ: Groq (свой ключ)'); return [true, t]; } }
      log(`  ↩ Groq: HTTP ${r.status_code} — пробую ещё раз`);
      if (r.status_code === 401) break;
    }
    if (!(this._use_shared() && STOCK.groq)) return [false, 'Groq сейчас не отвечает (лимит ключа). Попробуйте через минуту.'];
  }
  if (!(this._use_shared() && STOCK.groq)) return [false, this._t('ai_no_key')];
  const q = this._ai_quota_check(); if (q) return [false, q];
  let r; try { r = await requests.post(CF_URL + '/ai/groq', { json: { messages, max_tokens: Math.min(max_tokens, 4000), temperature: 0.9, prefer }, timeout: 150 }); }
  catch (e) { return [false, this._t('ai_network')]; }
  if (r.status_code === 200) { const t = pick(r.json()); if (t) { this._ai_quota_mark(); log(`  🤖 ИИ: ${/^gemini/i.test(r.headers.get('X-VR-Model') || '') ? 'Gemini' : 'Groq'}`); return [true, t]; } return [false, this._t('ai_empty')]; }
  log(`  ✖ общий ИИ: HTTP ${r.status_code}`);
  return [false, 'Общий ИИ сейчас перегружен — попробуйте через минуту или вставьте свой бесплатный ключ Groq или Gemini (без лимита).'];
};

// лимит запросов к общему ИИ за 60 минут (сценарии, перегенерации, подписи)
P._ai_quota_key = function () { return `vr_${this._prod_id()}_ai_hour`; };
P._ai_quota_list = function () { let l = []; try { l = JSON.parse(store.get(this._ai_quota_key()) || '[]'); } catch (e) { } const t = Date.now(); return (Array.isArray(l) ? l : []).filter(x => typeof x === 'number' && x > t - 3600000 && x > (STOCK.reset || 0) && x <= t + 60000); };
P._ai_quota_check = function () {
  return null;   // площадка владельца — без лимитов
  const lim = this._shared_limits().ai_limit, l = this._ai_quota_list().sort((a, b) => a - b);
  if (l.length < lim) return null;
  const mins = Math.max(1, Math.ceil((l[l.length - lim] + 3600000 - Date.now()) / 60000));
  return `Лимит общего ИИ: ${lim} запросов в час. Следующий — через ${mins} мин. Или вставьте свой бесплатный ключ Groq или Gemini в разделе «Ключи» — без лимита.`;
};
P._ai_quota_mark = function () { const l = this._ai_quota_list(); l.push(Date.now()); store.set(this._ai_quota_key(), JSON.stringify(l.slice(-200))); };

// Галочка снята и нужного ключа нет -> вместо «Key не задан» понятная подсказка, что делать
const KEY_MSG_IDS = new Set(['ai_no_key', 'gem_no_key', 'stock_key_needed_mine', 'need_media_key', 'cm_need_media_key', 'cm_msg_need_media_key', 'm1_no_key', 'm2_no_key']);
P._need_keys_msg = function () { return `Нет ключей. Включите галочку «Наши ключи» на главной странице (раздел «Ключи») — наши ключи, без лимита (при нагрузке — короткая очередь). Или вставьте свои ключи Pexels, Pixabay и бесплатного ИИ (Gemini или Groq).`; };
{ const _t0 = P._t; P._t = function (key, ...args) { if (KEY_MSG_IDS.has(key) && this._shared_ready() && !this._use_shared()) return this._need_keys_msg(); return _t0.call(this, key, ...args); }; }
