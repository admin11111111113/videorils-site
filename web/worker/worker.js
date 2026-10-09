// Видеорилс — Cloudflare-помощник веб-версии: (1) посредник Edge-TTS, (2) быстрый триал /trial,
// (3) кэш чтений (идеи дня, тарифы, словарь, ссылки) — веб не ждёт спящий Render; (4) cron: досылка триала.
// Посредник Edge-TTS: Microsoft пускает websocket «Read aloud»
// только с User-Agent браузера Edge; из Chrome/Safari/Firefox сайт его подменить не может.
// Worker пересылает websocket 1:1 (те же speech.config/SSML/audio, что у edge_tts), подставляя UA.
const UPSTREAM = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const ALLOWED = [/^https:\/\/(www\.)?videorils\.com$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];

const LICENSE_SERVER = 'https://videorils-server-7t7t.onrender.com';   // единственный боевой сервер (новый аккаунт Render)
const PRODUCTS = ['mini', 'lite', 'pro'];

// запрос к серверу лицензий с жёстким таймаутом (Render может спать/висеть)
async function render(path, body, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(LICENSE_SERVER + path, { method: body ? 'POST' : 'GET', signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status !== 200) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// Триал веб-версии (1 бесплатное видео на ПК на продукт): отвечаем СРАЗУ из Cloudflare KV,
// сервер лицензий (Firebase) — источник для старых записей и зеркало для админки.
//  status: в KV «использован» -> сразу нет; иначе спрашиваем сервер (до 6 с), не ответил -> по KV.
//  use: пишем в KV мгновенно, на сервер — фоном (не дошло -> досылает cron).

// naive ISO сервера (UTC без зоны) -> мс
const pyParse = (v) => { if (!v) return null; const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z'); return Number.isNaN(t) ? null : t; };
// promo.machine_promo — дни считает сервер (timedelta.days + 1, если есть остаток секунд)
function machinePromo(rec) {
  const exp = pyParse(rec.promo_expires_at), now = Date.now();
  const active = !!(exp && exp > now);
  let left = 0;
  if (active) { const d = exp - now; left = Math.max(0, Math.floor(d / 86400000) + (Math.floor((d % 86400000) / 1000) ? 1 : 0)); }
  return { promo_active: active, promo_code: rec.promo_code || null, promo_expires_at: rec.promo_expires_at || null,
    promo_days_left: left, promo_used_codes: Object.values(asDict(rec.promo_used_codes)) };
}
// /trial прямо в Firebase — 1:1 с app.py trial() (флаг на продукт, легаси trial_used = Мини)
async function trialFb(env, machine, product, action) {
  const rec = (await fb(env, 'GET', `/videorils_machines/${encodeURIComponent(machine)}`)) || {};
  const flag = `trial_used_${product}`;
  const used = !!rec[flag] || (!!rec.trial_used && product === 'mini');
  if (action === 'use') {
    if (used) return [200, { status: 'used', trial_available: false, product }];
    await fb(env, 'PATCH', `/videorils_machines/${encodeURIComponent(machine)}`, { [flag]: true, [`trial_at_${product}`]: pyNow() });
    return [200, { status: 'ok', trial_available: false, product }];
  }
  return [200, Object.assign({ status: 'ok', trial_available: !used, trial_used: used, product }, machinePromo(rec))];
}
async function trial(env, ctx, d) {
  const machine = String(d.machine || '').trim().slice(0, 64);
  let product = String(d.product || 'mini').trim().toLowerCase(); if (!PRODUCTS.includes(product)) product = 'mini';
  const action = d.action || 'status';
  if (!machine) return [400, { status: 'error', msg: 'bad request' }];
  const tk = `t:${product}:${machine}`, pk = `p:${machine}`, mk = `m:${product}:${machine}`;
  if (action === 'reset') {               // админ (тесты): решает сервер, KV чистим только при успехе
    const r = await render('/trial', d, 20000);
    if (r && r.status === 'ok') { await env.TRIALS.delete(tk); await env.TRIALS.delete(mk); }
    return [r ? 200 : 502, r || { status: 'error' }];
  }
  if (fbOn(env) && (action === 'use' || action === 'status')) {
    try { return await trialFb(env, machine, product, action); } catch (e) { /* база недоступна -> KV/Render ниже */ }
  }
  const used = !!(await env.TRIALS.get(tk));
  if (action === 'use') {
    if (used) return [200, { status: 'used', trial_available: false, product }];
    await env.TRIALS.put(tk, new Date().toISOString());
    await env.TRIALS.put(mk, '1');
    ctx.waitUntil(mirrorUse(env, product, machine));
    return [200, { status: 'ok', trial_available: false, product }];
  }
  const promo = async () => { try { return JSON.parse((await env.TRIALS.get(pk)) || 'null'); } catch (e) { return null; } };
  if (used) return [200, Object.assign({ status: 'ok', trial_available: false, trial_used: true, product }, (await promo()) || {})];
  const r = await render('/trial', { machine, action: 'status', product }, 6000);
  if (r && r.status === 'ok') {
    if (r.trial_available === false) await env.TRIALS.put(tk, 'server');
    // промо кэшируем, только пока оно активно (лимит записей KV)
    if (r.promo_active) await env.TRIALS.put(pk, JSON.stringify({ promo_active: true, promo_code: r.promo_code || '', promo_days_left: r.promo_days_left || 0 }), { expirationTtl: 86400 });
    else if (await env.TRIALS.get(pk)) await env.TRIALS.delete(pk);
    return [200, r];
  }
  return [200, Object.assign({ status: 'ok', trial_available: true, trial_used: false, product }, (await promo()) || {})];
}
async function mirrorUse(env, product, machine) {
  const r = await render('/trial', { machine, action: 'use', product }, 25000);
  if (r && (r.status === 'ok' || r.status === 'used')) await env.TRIALS.delete(`m:${product}:${machine}`);
}


// ---------------- кэш чтений сервера лицензий (веб не ждёт, пока Render проснётся) ----------------
// Отдаём из KV СРАЗУ; устарело -> фоном обновляем с Render (этот же запрос его и будит).
// Кэша ещё нет совсем -> один раз ждём Render (до 50 с). Сервер можно не держать без сна.
const CACHED = { '/trending-ideas': 0, '/pronunciation-dict': 3 * 3600, '/product-plans': 3600, '/plans': 3600,
  '/key-links': 3600, '/stats': 900 };
const todayUTC = () => new Date().toISOString().slice(0, 10);
function cacheKey(url) {
  const q = new URLSearchParams(url.search); q.delete('machine_id');
  const keep = [...q.entries()].filter(([k]) => ['lang', 'product'].includes(k)).sort();
  return 'c:' + url.pathname + (keep.length ? '?' + new URLSearchParams(keep) : '');
}
function isFresh(path, rec) {
  const age = (Date.now() - (rec.at || 0)) / 1000;
  if (path === '/trending-ideas') return (rec.body && rec.body.date === todayUTC()) ? age < 6 * 3600 : age < 1800;
  return age < CACHED[path];
}

const asDict = (v) => Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x]).filter(([, x]) => x)) : (v && typeof v === 'object' ? v : {});
async function fbRead(env, path, search) {
  if (path === '/pronunciation-dict') { const d = asDict(await fb(env, 'GET', '/pronunciation_dict')); return { ok: true, dict: d, count: Object.keys(d).length }; }
  if (path === '/key-links') return asDict(await fb(env, 'GET', '/key_links'));
  if (path === '/trending-ideas') {
    const lang = (new URLSearchParams(search).get('lang') || 'ru').trim().toLowerCase() === 'en' ? 'en' : 'ru';
    const root = lang === 'en' ? '/trending_ideas_en' : '/trending_ideas';
    const last = asDict(await fb(env, 'GET', root, undefined, 'orderBy=%22%24key%22&limitToLast=1'));
    const custom = lang !== 'en' ? Object.values(asDict(await fb(env, 'GET', '/trending_custom'))).filter((v) => v && typeof v === 'object') : [];
    const hidden = new Set(Object.keys(asDict(await fb(env, 'GET', '/trending_hidden'))));
    const keys = Object.keys(last);
    if (!keys.length) { const ideas = custom.filter((i) => !hidden.has(i.id)); return { date: ideas.length ? todayUTC() : null, ideas, stale: !ideas.length, lang }; }
    const latest = keys.sort().pop(), rec = last[latest] || {};
    const ideas = custom.concat(rec.ideas || []).filter((i) => !hidden.has(i && i.id));
    return { date: rec.date || latest, ideas, generated_at: rec.generated_at || '', stale: latest !== todayUTC(), lang };
  }
  return null;
}
async function refresh(env, key, path, search, ms) {
  const q = new URLSearchParams(search); if (path === '/trending-ideas') q.delete('machine_id');   // общий пул
  let body = null;
  if (fbOn(env) && ['/trending-ideas', '/pronunciation-dict', '/key-links'].includes(path)) { try { body = await fbRead(env, path, search); } catch (e) { body = null; } }
  if (!body) body = await render(path + (q.toString() ? '?' + q : ''), null, ms);
  if (!body || (path === '/trending-ideas' && !(body.ideas && body.ideas.length))) return null;
  const rec = { at: Date.now(), body };
  await env.TRIALS.put(key, JSON.stringify(rec));
  return rec;
}
// персональная подвыборка 15–20 идей с перемешанным порядком, детерминированно по (machine_id, день) —
// как personalize_ideas на сервере: один ПК весь день видит свой набор, разные ПК — разные
async function personalize(ideas, mid, date) {
  const pool = (ideas || []).slice(); if (!pool.length || !mid) return pool;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mid + '|' + date)));
  let a = (h[0] | h[1] << 8 | h[2] << 16 | h[3] << 24) >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const n = Math.min(pool.length, 15 + Math.floor(rnd() * 6));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
async function cachedGet(env, ctx, url) {
  const path = url.pathname, key = cacheKey(url);
  let rec = null; try { rec = JSON.parse((await env.TRIALS.get(key)) || 'null'); } catch (e) { }
  if (!rec) rec = await refresh(env, key, path, url.search, 50000);
  else if (!isFresh(path, rec)) {
    // один фоновый апдейт на ключ за раз (метка в Cache API — не тратит лимит записей KV)
    const lock = new Request('https://lock.local/' + encodeURIComponent(key));
    if (!(await caches.default.match(lock))) {
      ctx.waitUntil(caches.default.put(lock, new Response('1', { headers: { 'Cache-Control': 'max-age=120' } })));
      ctx.waitUntil(refresh(env, key, path, url.search, 28000));
    }
  }
  if (!rec) return null;
  let body = rec.body;
  if (path === '/trending-ideas') {
    const mid = (url.searchParams.get('machine_id') || '').trim();
    body = Object.assign({}, body, { stale: !!body.stale || body.date !== todayUTC() });
    if (mid) { body.ideas = await personalize(body.ideas, mid, todayUTC()); body.personalized = true; body.count = body.ideas.length; }
  }
  return body;
}


// ---------------- Firebase RTDB напрямую (та же база, что у сервера лицензий) ----------------
// Секреты: FIREBASE_SERVICE_ACCOUNT (JSON сервис-аккаунта), FIREBASE_DB_URL. Нет секретов ->
// запрос пересылается на Render, как раньше.
let _fbTok = null, _fbExp = 0;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
async function fbToken(env) {
  if (_fbTok && Date.now() < _fbExp) return _fbTok;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email' }));
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(head + '.' + claim)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + sig });
  const d = await r.json(); if (!d.access_token) throw new Error('firebase token failed');
  _fbTok = d.access_token; _fbExp = Date.now() + (d.expires_in - 300) * 1000;
  return _fbTok;
}
const fbOn = (env) => !!(env.FIREBASE_SERVICE_ACCOUNT && env.FIREBASE_DB_URL);
async function fb(env, method, path, body, query) {
  const url = env.FIREBASE_DB_URL.replace(/\/+$/, '') + path + '.json' + (query ? '?' + query : '');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + await fbToken(env), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`firebase ${method} ${path}: ${r.status}`);
  return await r.json();
}
// datetime.now().isoformat() сервера (Render = UTC, без зоны, микросекунды)
const pyNow = () => new Date().toISOString().slice(0, 23) + '000';
async function md5hex(s) { return [...new Uint8Array(await crypto.subtle.digest('MD5', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
const keyId = async (key) => (await md5hex(key.trim().toUpperCase())).slice(0, 12);
// _expiry_end: «%Y-%m-%d» — действует включительно по этот день; старый «%Y-%m» — до 1-го числа следующего месяца
function expiryEnd(type, expires) {
  const e = String(expires || '').trim();
  if (!['monthly', 'yearly'].includes(type) || !e) return null;
  if (e.length === 7) { const [y, m] = e.split('-').map(Number); if (!y || !m) return null; return Date.UTC(y, m, 1); }
  const t = Date.parse(e.slice(0, 10) + 'T00:00:00Z'); return Number.isNaN(t) ? null : t + 86400000;
}
// referrals.referral_code / stats_for_key
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
async function referralCode(key) {
  const k = (key || '').trim().toUpperCase(); if (!k) return '';
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('videorils-ref-v1:' + k)));
  let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  let out = ''; for (let i = 0; i < 8; i++) { out += REF_ALPHABET[Number(n % 32n)]; n /= 32n; }
  return out;
}
const r2 = (x) => Math.round(x * 100) / 100;
async function refStats(env, key) {
  try {
    const code = await referralCode(key); if (!code) return null;
    let data = (await fb(env, 'GET', '/videorils_referrals')) || {};
    if (Array.isArray(data)) data = Object.fromEntries(data.map((v, i) => [String(i), v]).filter(([, v]) => v));
    const rows = Object.values(data).filter((r) => r && typeof r === 'object' && r.ref_code === code);
    const ok = rows.filter((r) => r.status === 'confirmed');
    const life = ok.filter((r) => (r.plan || 'lifetime') === 'lifetime');
    const paid = ok.filter((r) => r.payout_id).reduce((a, r) => a + parseFloat(r.amount_usd || 0), 0);
    const total = life.reduce((a, r) => a + parseFloat(r.amount_usd || 0), 0);
    return { code, count: ok.length, lifetime: life.length, per: 5.0, reward: r2(total), paid_out: r2(paid) };
  } catch (e) { return null; }
}
const PRODUCT_NAMES = { mini: 'Видеорилс Мини', lite: 'Видеорилс Лайт', pro: 'Видеорилс Про' };
// /check: проверка ключа + привязка к ПК — 1:1 с app.py check()
async function check(env, d) {
  const key = String(d.key || '').trim().toUpperCase(), machine = String(d.machine || '').trim();
  const product = String(d.product || 'mini').trim().toLowerCase();
  if (!key || !machine) return [400, { status: 'error', msg: 'bad request' }];
  const kid = await keyId(key);
  const lic = await fb(env, 'GET', `/videorils_licenses/${kid}`);
  if (!lic) return [200, { status: 'invalid', msg: 'Ключ не найден' }];
  if (lic.blocked) return [200, { status: 'blocked', msg: 'Ключ заблокирован' }];
  const lp = String(lic.product || 'mini').trim().toLowerCase();
  if (lp !== product) return [200, { status: 'wrong_product', product: lp, msg: 'Этот ключ для другого продукта — ' + (PRODUCT_NAMES[lp] || lp) }];
  const end = expiryEnd(lic.type, lic.expires);
  if (end !== null && Date.now() >= end) return [200, { status: 'expired', msg: 'Подписка истекла' }];
  const bound = lic.machine || '';
  if (!bound) {
    const t = pyNow(); await fb(env, 'PATCH', `/videorils_licenses/${kid}`, { machine, activated_at: t, last_seen: t });
    return [200, { status: 'ok', type: lic.type || 'lifetime', referrals: await refStats(env, key) }];
  }
  if (bound !== machine) return [200, { status: 'wrong_machine', msg: 'Ключ привязан к другому компьютеру' }];
  await fb(env, 'PATCH', `/videorils_licenses/${kid}`, { last_seen: pyNow() });
  return [200, { status: 'ok', type: lic.type || 'lifetime', referrals: await refStats(env, key) }];
}


// Всё остальное — 1:1 на сервер лицензий (оплата, промо, рефералы, апгрейд, телеметрия, админка…).
// Приложения знают ТОЛЬКО адрес Cloudflare — сервер можно переносить, не обновляя приложения.
async function proxy(req, url, origin) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  const h = new Headers(req.headers);
  for (const k of ['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) h.delete(k);
  const ip = req.headers.get('cf-connecting-ip'); if (ip) h.set('X-Forwarded-For', ip);
  let r;
  try {
    r = await fetch(LICENSE_SERVER + url.pathname + url.search, { method: req.method, headers: h,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(), redirect: 'manual' });
  } catch (e) { return new Response(JSON.stringify({ status: 'error', msg: 'server unreachable' }), { status: 502, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin)) }); }
  const out = new Headers(r.headers);
  for (const [k, v] of Object.entries(cors(origin))) out.set(k, v);
  return new Response(r.body, { status: r.status, headers: out });
}

const cors = (origin) => !origin ? {} : ({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });

export default {
  // раз в час: досылаем на сервер лицензий отметки триала, которые не дошли сразу.
  // Сервер НЕ будим впустую (бесплатные часы Render) — запрос только если есть что досылать.
  async scheduled(ev, env, ctx) {
    ctx.waitUntil((async () => {
      const list = await env.TRIALS.list({ prefix: 'm:', limit: 50 });
      for (const k of list.keys) { const [, product, machine] = k.name.split(':'); await mirrorUse(env, product, machine); }
    })());
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    // браузер — только с нашего сайта; без Origin — десктопные приложения (к API пускаем, к Edge-TTS — нет)
    const fromSite = ALLOWED.some(r => r.test(origin));
    if (origin && !fromSite) return new Response('forbidden', { status: 403 });
    if (!origin && url.pathname === '/edge') return new Response('forbidden', { status: 403 });
    if (url.pathname in CACHED) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
      const body = await cachedGet(env, ctx, url);
      return new Response(JSON.stringify(body || {}), { status: body ? 200 : 502, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin)) });
    }
    if (url.pathname === '/check') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
      let d = {}; try { d = await req.json(); } catch (e) { }
      let code = 502, out = null;
      if (fbOn(env)) { try { [code, out] = await check(env, d || {}); } catch (e) { out = null; } }
      if (!out) { out = await render('/check', d || {}, 50000); code = out ? 200 : 502; out = out || { status: 'error' }; }
      return new Response(JSON.stringify(out), { status: code, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin)) });
    }
    if (url.pathname === '/trial') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
      let d = {}; try { d = await req.json(); } catch (e) { }
      const [code, out] = await trial(env, ctx, d || {});
      return new Response(JSON.stringify(out), { status: code, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin)) });
    }
    if (url.pathname !== '/edge') return await proxy(req, url, origin);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ok', { status: 200 });
    const up = await fetch(UPSTREAM + url.search, {
      headers: { Upgrade: 'websocket', 'User-Agent': EDGE_UA, Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
    });
    const ws = up.webSocket;
    if (!ws) return new Response('upstream ' + up.status, { status: 502 });
    ws.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // двоичные кадры (аудио) приходят Blob'ами — переводим в ArrayBuffer, порядок держим цепочкой
    const relay = (dst) => { let chain = Promise.resolve(); return (e) => { const d = e.data;
      chain = chain.then(async () => { try { dst.send(d instanceof Blob ? await d.arrayBuffer() : d); } catch (x) { } }); }; };
    server.addEventListener('message', relay(ws));
    ws.addEventListener('message', relay(server));
    // 1005/1006/1015 — зарезервированы (их нельзя отправить в close()): иначе исключение и клиент
    // не узнаёт об обрыве, ждёт таймаут. Обрыв со стороны Microsoft (1006 = отказ/лимит) -> 1011.
    const sendable = (c) => (c === 1000 || (c >= 3000 && c <= 4999) || (c >= 1001 && c <= 1014 && c !== 1004 && c !== 1005 && c !== 1006)) ? c : (c === 1005 ? 1000 : 1011);
    let closed = false;
    const closeBoth = (code, reason) => { if (closed) return; closed = true; const c = sendable(code || 1000); const r = String(reason || '').slice(0, 120);
      try { server.close(c, r); } catch (x) { try { server.close(1011); } catch (y) { } } try { ws.close(c, r); } catch (x) { try { ws.close(1011); } catch (y) { } } };
    server.addEventListener('close', (e) => closeBoth(e.code, e.reason));
    ws.addEventListener('close', (e) => closeBoth(e.code, e.reason));
    server.addEventListener('error', () => closeBoth(1011)); ws.addEventListener('error', () => closeBoth(1011));
    return new Response(null, { status: 101, webSocket: client });
  },
};
