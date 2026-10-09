// Видеорилс Лайт — ВЕБ. Базовый слой: замены того, что в app.py давала ОС
// (settings.json, папка temp, print/log, threading, sleep, webbrowser, call_js).
// Логику НЕ меняем — только среду исполнения.
import { RAW } from './consts.js';
const W = '[\\p{L}\\p{N}_]', NW = '[^\\p{L}\\p{N}_]';
const WB = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const NWB = `(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`;
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if ('__re__' in v) return pyre(v.__re__, v.flags || '');
    if ('__set__' in v) return new Set(v.__set__.map(revive));
    const o = {}; for (const k in v) o[k] = revive(v[k]); return o;
  }
  return v;
}
// C — все константы app.py (промпты, MSGS, STYLES, словари). Ленивая инициализация,
// т.к. pyre объявлен ниже (function-hoisting это позволяет).
export const C = revive(RAW);

export const BUILD_VARIANT = 'ru';
export const APP_VERSION = C.APP_VERSION;          // та же версия логики, что и десктоп
export const WEB_VERSION = 'web-' + C.APP_VERSION;
// сервер лицензий — только через Cloudflare (быстрые ответы + пересылка на Render)
export const VR_SERVER_URL = 'https://videorils-tts.videorils.workers.dev';
// Cloudflare-помощник: быстрый триал + кэш чтений сервера лицензий (не ждём спящий Render)
export const CF_URL = 'https://videorils-tts.videorils.workers.dev';

// ---------------------------------------------------------------- sleep/time --
export const sleep = (sec) => new Promise(r => setTimeout(r, Math.max(0, sec * 1000)));
export const now = () => Date.now() / 1000;              // time.time()
export function strftime(fmt, d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return fmt.replace('%Y', d.getFullYear()).replace('%m', p(d.getMonth() + 1)).replace('%d', p(d.getDate()))
    .replace('%H', p(d.getHours())).replace('%M', p(d.getMinutes())).replace('%S', p(d.getSeconds()));
}
export const isoNow = () => { const d = new Date(); const z = new Date(d - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 23).replace('Z', ''); };

// --------------------------------------------------- settings.json -> storage --
const SKEY = 'vr_lite_settings';
// Настройки/ключи/лицензия/триал — localStorage + КОПИЯ в IndexedDB: браузер (нет места на
// диске, «очистка», расширения) может потерять одно из хранилищ — при запуске восстанавливаем
// из другого (restoreStore). Плюс просим «постоянное хранилище», чтобы браузер не стирал сам.
const BK_DB = 'vr_backup', BK_ST = 'kv';
let _bkDb = null;
function bkOpen() {
  if (_bkDb) return _bkDb;
  _bkDb = new Promise((res) => { try { const r = indexedDB.open(BK_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(BK_ST);
    r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } });
  return _bkDb;
}
function bkPut(k, v) { bkOpen().then((db) => { if (!db) return; try { const s = db.transaction(BK_ST, 'readwrite').objectStore(BK_ST); v === null ? s.delete(k) : s.put(v, k); } catch (e) { } }); }
function bkAll() {
  return bkOpen().then((db) => new Promise((res) => { if (!db) return res({}); try { const out = {}; const c = db.transaction(BK_ST, 'readonly').objectStore(BK_ST).openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(out); }; c.onerror = () => res(out); } catch (e) { res({}); } }));
}
const _bkKey = (k) => typeof k === 'string' && k.startsWith('vr_');
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return _mem[k] ?? null; } }
function lsSet(k, v) { if (_bkKey(k)) bkPut(k, String(v)); _mem[k] = String(v); try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { if (_bkKey(k)) bkPut(k, null); delete _mem[k]; try { localStorage.removeItem(k); } catch (e) { } }
const _mem = {};
export const store = { get: lsGet, set: lsSet, del: lsDel };
// при запуске (до создания Api): то, чего нет в localStorage, берём из копии; и наоборот — докладываем копию
export async function restoreStore() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { }); } catch (e) { }
  try {
    const bk = await bkAll();
    for (const [k, v] of Object.entries(bk)) { let cur = null; try { cur = localStorage.getItem(k); } catch (e) { }
      if (cur === null) { _mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { } } }
    let n = 0; try { n = localStorage.length; } catch (e) { }
    for (let i = 0; i < n; i++) { const k = localStorage.key(i); if (_bkKey(k) && !(k in bk)) bkPut(k, localStorage.getItem(k)); }
  } catch (e) { }
}

export function load_settings() {
  try { return JSON.parse(lsGet(SKEY) || '{}') || {}; } catch (e) { return {}; }
}
export function save_settings(data) {
  try { lsSet(SKEY, JSON.stringify(data)); } catch (e) { console.warn('settings save err:', e); }
}
// ключи в браузере лежат в localStorage этого сайта; enc:-обёртка десктопа (XOR машинным
// секретом) здесь не даёт защиты — храним как есть, формат dec_secret совместим.
export const enc_secret = (s) => s || '';
export const dec_secret = (s) => (s && !String(s).startsWith('enc:')) ? s : (s ? '' : '');

// ------------------------------------------------------------ call_js / log --
export function call_js(fn, ...args) {
  try { const f = window[fn]; if (typeof f === 'function') return f(...args); }
  catch (e) { console.warn('js err:', fn, e); }
}
let BUILD_LOG = null;                    // output/build.log -> массив строк в памяти
export function log(msg) {
  msg = String(msg);
  try { console.log(msg); } catch (e) { }
  if (BUILD_LOG) BUILD_LOG.push(`[${strftime('%H:%M:%S')}] ${msg}`);
  call_js('pushLog', msg);
}
export function _build_log_open(append = false, tag = 'build') {
  if (append && BUILD_LOG) return;
  BUILD_LOG = [`=== ${tag} ${strftime('%Y-%m-%d %H:%M:%S')} ===`];
}
export function _build_log_close() {
  if (BUILD_LOG) { BUILD_LOG.push(`=== build end ${strftime('%Y-%m-%d %H:%M:%S')} ===`); vfs.writeText('output/build.log', BUILD_LOG.join('\n')); }
  BUILD_LOG = null;
}
export function bar(pct, label) { call_js('setBar', Math.trunc(pct), label || ''); }

// ------------------------------------------------- виртуальная файловая система --
// Пути как в десктопе ('temp/tts_0001.mp3', 'output/rils_123.mp4'). Содержимое — Blob
// в памяти + копия в Cache Storage, откуда её раздаёт Service Worker (sw.js) по тому
// же ОТНОСИТЕЛЬНОМУ URL (как http-сервер pywebview): <video src="temp/x.mp4?t=1">.
const FILES = new Map();
const PENDING = new Map();
export const VFS_CACHE = 'vr-vfs-v1';
let _cacheP = null;
function cacheOpen() { if (!_cacheP) _cacheP = (self.caches ? caches.open(VFS_CACHE) : Promise.reject(new Error('no caches'))); return _cacheP; }
function vfsKey(p) { return new URL(p, VFS_BASE).href; }
export const VFS_BASE = (typeof location !== 'undefined') ? new URL('./', location.href).href : 'http://localhost/';
export const vfs = {
  write(path, blob) {
    path = norm(path); const b = blob instanceof Blob ? blob : new Blob([blob]);
    FILES.set(path, b);
    const p = cacheOpen().then(c => c.put(vfsKey(path), new Response(b, { headers: { 'Content-Type': b.type || mimeOf(path), 'Content-Length': String(b.size) } }))).catch((e) => { console.warn('VFS: не записано в хранилище браузера (мало места?) — отдаём из памяти:', path, e && e.name); });
    PENDING.set(path, p); p.then(() => { if (PENDING.get(path) === p) PENDING.delete(path); });
    return path;
  },
  writeText(path, text, type = 'text/plain') { return this.write(path, new Blob([text], { type })); },
  read(path) { return FILES.get(norm(path)) || null; },
  exists(path) { return FILES.has(norm(path)); },
  size(path) { const b = FILES.get(norm(path)); return b ? b.size : 0; },
  remove(path) { path = norm(path); FILES.delete(path); cacheOpen().then(c => c.delete(vfsKey(path))).catch(() => { }); },
  list(prefix) { prefix = norm(prefix); return [...FILES.keys()].filter(k => k.startsWith(prefix)); },
  copy(src, dst) { const b = this.read(src); if (b) this.write(dst, b); return !!b; },
  async flush(path) { const p = PENDING.get(norm(path)); if (p) await p; },
  async flushAll() { await Promise.all([...PENDING.values()]); },
  url(path) { return norm(path); },                       // относительный, как в десктопе
  objectUrl(path) { const b = this.read(path); return b ? URL.createObjectURL(b) : ''; },
  async clearDir(prefix) { for (const k of this.list(prefix)) this.remove(k); },
  // файл из прошлой сессии (Cache Storage) -> снова в память
  async restore(path) {
    path = norm(path); if (FILES.has(path)) return true;
    try { const c = await cacheOpen(); const r = await c.match(vfsKey(path)); if (!r) return false; FILES.set(path, await r.blob()); return true; } catch (e) { return false; }
  },
  // старт сессии: temp/ прошлой сессии не нужен (как чистка temp в десктопе)
  async purge(prefixes) {
    try { const c = await cacheOpen(); for (const req of await c.keys()) { const rel = req.url.startsWith(VFS_BASE) ? req.url.slice(VFS_BASE.length) : ''; if (prefixes.some(p => rel.startsWith(p))) await c.delete(req); } } catch (e) { }
  },
};
export function mimeOf(p) {
  const e = (String(p).split('.').pop() || '').toLowerCase().split('?')[0];
  return ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain', log: 'text/plain', ass: 'text/plain', json: 'application/json' })[e] || 'application/octet-stream';
}
function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
export const path = {
  join: (...a) => a.filter(x => x !== '' && x != null).join('/').replace(/\/+/g, '/'),
  basename: (p) => norm(p).split('/').pop(),
  dirname: (p) => { const s = norm(p).split('/'); s.pop(); return s.join('/'); },
  splitext: (p) => { const b = norm(p); const i = b.lastIndexOf('.'); const j = b.lastIndexOf('/'); return i > j ? [b.slice(0, i), b.slice(i)] : [b, '']; },
};
export const TEMP_DIR = 'temp', OUTPUT_DIR = 'output', ASSETS_DIR = 'assets', INPUT_DIR = 'input';

// ------------------------------------------------------- Python-совместимые RE --
// Python re по умолчанию Unicode-aware: \b, \w работают с кириллицей. В JS \b/\w —
// только ASCII даже с флагом u, поэтому переводим их в явные Unicode-классы.
export function pyre(src, flags = '') {
  let s = String(src), out = '', inClass = false;
  if (s.startsWith('(?i)')) { s = s.slice(4); if (!flags.includes('i')) flags += 'i'; }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (!inClass && n === 'b') { out += WB; i++; continue; }
      if (!inClass && n === 'B') { out += NWB; i++; continue; }
      if (n === 'w') { out += inClass ? '\\p{L}\\p{N}_' : W; i++; continue; }
      if (n === 'W') { out += inClass ? '' : NW; if (inClass) out += '\\P{L}'; i++; continue; }
      if (n === 'Z') { out += '$(?![\\s\\S])'; i++; continue; }
      if (n === 'A') { out += '^'; i++; continue; }
      // Python терпит \<любой знак>; JS-u — только синтакс. символы (+ '-' в классе)
      if (!/[A-Za-z0-9]/.test(n) && !'^$\\.*+?()[]{}|/'.includes(n) && !(n === '-' && inClass)) { out += n === '-' ? '\\x2d' : n; i++; continue; }
      out += ch + n; i++; continue;
    }
    if (ch === '[' && !inClass) inClass = true; else if (ch === ']' && inClass) inClass = false;
    out += ch;
  }
  if (!flags.includes('u') && !flags.includes('v')) flags += 'u';
  return new RegExp(out, flags);
}
export const re = {
  sub(p, repl, s, flags = '') {         // re.sub (все вхождения); repl — строка с \1 или функция
    const rx = p instanceof RegExp ? new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g') : pyre(p, flags + 'g');
    if (typeof repl === 'function') return String(s).replace(rx, (...m) => repl(mObj(m)));
    return String(s).replace(rx, String(repl).replace(/\\g<(\d+)>/g, '$$$1').replace(/\\(\d)/g, '$$$1'));
  },
  search(p, s, flags = '') { const rx = p instanceof RegExp ? p : pyre(p, flags); const m = String(s).match(new RegExp(rx.source, rx.flags.replace('g', ''))); return m ? mObj(m) : null; },
  match(p, s, flags = '') { const rx = p instanceof RegExp ? p : pyre(p, flags); const m = String(s).match(new RegExp('^(?:' + rx.source + ')', rx.flags.replace('g', ''))); return m ? mObj(m) : null; },
  fullmatch(p, s, flags = '') { const rx = p instanceof RegExp ? p : pyre(p, flags); const m = String(s).match(new RegExp('^(?:' + rx.source + ')$', rx.flags.replace('g', ''))); return m ? mObj(m) : null; },
  findall(p, s, flags = '') {
    const rx = p instanceof RegExp ? new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g') : pyre(p, flags + 'g');
    const out = []; for (const m of String(s).matchAll(rx)) out.push(m.length > 2 ? m.slice(1) : (m.length === 2 ? (m[1] ?? '') : m[0])); return out;
  },
  split(p, s, flags = '') {          // re.split: группы захвата включаются (как в Python)
    const rx = p instanceof RegExp ? p : pyre(p, flags);
    return String(s).split(new RegExp(rx.source, rx.flags.replace('g', ''))).map(x => x === undefined ? '' : x);
  },
  escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); },
};
function mObj(m) {
  // m: результат match/replace callback -> объект как Python Match
  let arr = Array.isArray(m) ? m : [...m];
  if (typeof arr[arr.length - 1] === 'object' && arr[arr.length - 1] !== null && !Array.isArray(arr[arr.length - 1])) arr = arr.slice(0, -1);
  // в replace-callback последние 2 элемента — offset и строка
  if (typeof arr[arr.length - 1] === 'string' && typeof arr[arr.length - 2] === 'number') { arr = arr.slice(0, -2); }
  const groups = arr;
  return { group: (i = 0) => groups[i] ?? null, groups: () => groups.slice(1), 0: groups[0], index: m.index };
}

// ------------------------------------------------------ Python-строковые утилиты --
export function pystrip(s, chars) {
  s = String(s ?? '');
  if (chars === undefined || chars === null) return s.trim();
  const set = new Set([...chars]); let a = 0, b = s.length;
  const arr = [...s]; a = 0; b = arr.length;
  while (a < b && set.has(arr[a])) a++;
  while (b > a && set.has(arr[b - 1])) b--;
  return arr.slice(a, b).join('');
}
export function pylstrip(s, chars) { s = String(s ?? ''); if (chars == null) return s.replace(/^\s+/, ''); const set = new Set([...chars]); const a = [...s]; let i = 0; while (i < a.length && set.has(a[i])) i++; return a.slice(i).join(''); }
export function pyrstrip(s, chars) { s = String(s ?? ''); if (chars == null) return s.replace(/\s+$/, ''); const set = new Set([...chars]); const a = [...s]; let i = a.length; while (i > 0 && set.has(a[i - 1])) i--; return a.slice(0, i).join(''); }
export const pysplit = (s) => String(s ?? '').split(/\s+/).filter(Boolean);   // str.split()
export const isdigit = (ch) => /^\p{Nd}+$/u.test(ch);
export const isalpha = (s) => /^\p{L}+$/u.test(s);
export const isupper = (s) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
export const islower = (s) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s);
export const capitalize = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
export const pyround = (x, n = 0) => { const f = 10 ** n; const v = x * f; const r = Math.round(v); return (Math.abs(v % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r) / f; }; // банковское (как Python)
export const pyint = (x) => { const v = parseInt(x, 10); if (Number.isNaN(v)) throw new Error('ValueError: int(' + x + ')'); return v; };
export const intOr = (x, d = 0) => { const v = parseInt(x, 10); return Number.isNaN(v) ? d : v; };
export const floatOr = (x, d = 0) => { const v = parseFloat(x); return Number.isNaN(v) ? d : v; };
export function fmt(n, d = 1) { return Number(n || 0).toFixed(d); }   // f"{x:.1f}"
export function choice(a) { return a[Math.floor(Math.random() * a.length)]; }
export function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function sortedBy(arr, key, reverse = false) {   // стабильная сортировка как sorted(key=)
  const idx = arr.map((v, i) => [key(v), i, v]);
  idx.sort((x, y) => { const c = cmp(x[0], y[0]); return (reverse ? -c : c) || (x[1] - y[1]); });
  return idx.map(x => x[2]);
}
function cmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  return a < b ? -1 : a > b ? 1 : 0;
}
export function maxBy(arr, key, dflt) { let best, bk, f = false; for (const v of arr || []) { const k = key(v); if (!f || cmp(k, bk) > 0) { best = v; bk = k; f = true; } } return f ? best : dflt; }
export function minBy(arr, key, dflt) { let best, bk, f = false; for (const v of arr || []) { const k = key(v); if (!f || cmp(k, bk) < 0) { best = v; bk = k; f = true; } } return f ? best : dflt; }

// ------------------------------------------------------------------ хеши --
export async function sha256Hex(s) { const b = await crypto.subtle.digest('SHA-256', typeof s === 'string' ? new TextEncoder().encode(s) : s); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function sha256Bytes(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? new TextEncoder().encode(s) : s)); }
export async function sha1Hex(s) { const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }

// --------------------------------------------------------------- HTTP (requests) --
// requests.get/post -> fetch с таймаутом. Ответ: {status_code, headers, text, json(), blob}
export async function http(method, url, { params, json, data, headers, timeout = 30, raw = false } = {}) {
  if (params) { const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v); url = u.toString(); }
  const ctl = new AbortController(); const to = Array.isArray(timeout) ? timeout[0] + timeout[1] : timeout;
  const timer = setTimeout(() => ctl.abort(), to * 1000);
  const h = Object.assign({}, headers || {});
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  else if (data !== undefined) body = data;
  try {
    const r = await fetch(url, { method, headers: h, body, signal: ctl.signal });
    if (raw) return r;
    const buf = await r.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    return {
      status_code: r.status, ok: r.ok, headers: { get: (k) => r.headers.get(k) }, text, buf,
      json() { return JSON.parse(text || 'null'); },
      blob(type) { return new Blob([buf], { type: type || r.headers.get('content-type') || '' }); },
    };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout: Read timed out (' + to + 's)');
    throw new Error('connection error: ' + (e && e.message || e));
  } finally { clearTimeout(timer); }
}
export const requests = {
  get: (url, o) => http('GET', url, o),
  post: (url, o) => http('POST', url, o),
  delete: (url, o) => http('DELETE', url, o),
};

// ---------------------------------------- файловый диалог (create_file_dialog) --
// ВАЖНО: вызывать СИНХРОННО из клика (до первого await) — иначе браузер блокирует.
export function pickFiles(accept = '', multiple = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    inp.style.display = 'none'; document.body.appendChild(inp);
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { inp.remove(); } catch (e) { } resolve(v); };
    inp.addEventListener('change', () => fin(inp.files && inp.files.length ? [...inp.files] : null));
    inp.addEventListener('cancel', () => fin(null));
    window.addEventListener('focus', () => setTimeout(() => { if (!inp.files || !inp.files.length) fin(null); }, 1500), { once: true });
    inp.click();
  });
}
export function b64ToBlob(b64, type = '') {
  const s = String(b64 || ''); const raw = atob(s.split(',').pop());
  const u = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
  const m = s.match(/^data:([^;,]+)/); return new Blob([u], { type: type || (m ? m[1] : '') });
}
export function blobToDataUrl(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); }); }

// --------------------------------------------------------------- прочее ОС --
export const webbrowser = { open(u) { try { window.open(u, '_blank', 'noopener'); return true; } catch (e) { return false; } } };
export function thread(fn) { Promise.resolve().then(fn).catch(e => console.warn('thread err', e)); }
export function uuid4hex() { return (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))).replace(/-/g, ''); }
