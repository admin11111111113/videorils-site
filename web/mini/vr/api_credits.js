// Атрибуция стоков (правила Pexels/Pixabay): кто автор клипа сцены + титры готового ролика.
import { stock_credit, stock_used_list, store } from './core.js';
import { Api } from './api_base.js';
const P = Api.prototype;
P.scene_credit = function (i) {
  const s = (this.reel_scenes || [])[parseInt(i)]; const p = s && s.pick;
  if (!p) return null;
  return stock_credit(p.url) || stock_credit(p.thumb) || null;
};
// титры: клипы сцен + всё, что скачано со стоков за последнюю сборку (в т.ч. нарезка)
P.get_reel_credits = function () {
  const out = [], seen = new Set();
  const add = (c) => { if (!c) return; const k = c.source + '|' + c.page; if (seen.has(k)) return; seen.add(k); out.push(c); };
  for (const s of (this.reel_scenes || [])) { const p = s && s.pick; if (p) add(stock_credit(p.url) || stock_credit(p.thumb)); }
  for (const c of stock_used_list()) add(c);
  return { credits: out.slice(0, 60) };
};

// Лимит в режиме «Наши ключи» (общие Pexels/Pixabay/Groq), за последние 60 минут на устройство:
// ролики — 1; запросы к общему ИИ — 15. Галочка снята (свои ключи) — без лимита.
// Считаем только ГОТОВОЕ (упавшая сборка не тратит).
const HOUR_MS = 3600000;
const QUOTA = { reel: { limit: 1, key: 'vr_mini_hour_builds' }, };
const OWN_KEY_TIP = 'Или снимите галочку «Наши ключи» и вставьте свои бесплатные ключи — без лимита.';
P._PROD = 'mini';
P._shared_limits = function () { return { limit: QUOTA.reel.limit, series_limit: QUOTA.series ? QUOTA.series.limit : 0, ai_limit: 15 }; };
P._on_shared_stock = function () { return this._use_shared(); };
P._hour_list = function (kind = 'reel') { let l = []; try { l = JSON.parse(store.get(QUOTA[kind].key) || '[]'); } catch (e) { } const t = Date.now(); return (Array.isArray(l) ? l : []).filter(x => typeof x === 'number' && x > t - HOUR_MS && x <= t + 60000); };
P._hour_quota_check = function (n = 1, kind = 'reel') {
  if (!QUOTA[kind] || !this._on_shared_stock()) return null;
  const lim = QUOTA[kind].limit, l = this._hour_list(kind).sort((a, b) => a - b);
  if (l.length + n <= lim) return null;
  const mins = Math.max(1, Math.ceil((l[l.length + n - lim - 1] + HOUR_MS - Date.now()) / 60000));
  const what = kind === 'series' ? (lim === 1 ? '1 серия' : `${lim} серии`) : `${lim} ${lim === 1 ? 'ролик' : 'ролика'}`;
  const next = kind === 'series' ? 'Следующую серию' : 'Следующий ролик';
  return { ok: false, code: 'hour_limit', msg: `Лимит на наших ключах: ${what} в час. ${next} можно будет собрать через ${mins} мин. ${OWN_KEY_TIP}` };
};
P._hour_quota_mark = function (kind = 'reel') { if (!QUOTA[kind] || !this._on_shared_stock()) return; const l = this._hour_list(kind); l.push(Date.now()); store.set(QUOTA[kind].key, JSON.stringify(l.slice(-20))); };
P.get_hour_quota = function () { const sh = this._on_shared_stock(); return { used: sh ? this._hour_list('reel').length : 0, series_used: sh && QUOTA.series ? this._hour_list('series').length : 0 }; };
