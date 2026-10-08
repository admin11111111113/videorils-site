// «Один компьютер — одна лицензия» для веба. Отпечаток считается из ЖЕЛЕЗА (видеокарта,
// ядра, память, платформа, часовой пояс) — одинаков в любом браузере этого ПК и после
// очистки браузера. Плюс хранится в 3 местах (localStorage, IndexedDB, cookie), чтобы не
// зависеть от смены монитора и т.п.: сохранённый id важнее пересчитанного.
const NAME = 'vr_mid_lite';

function gpu() {
  try {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    // «ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x...) Direct3D11 ...)» -> без версии API/драйвера
    return String(v + '|' + r).replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/Direct3D\d+.*|OpenGL.*|Vulkan.*|Metal.*/i, '').trim();
  } catch (e) { return ''; }
}
async function platform() {
  try { if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) { const h = await navigator.userAgentData.getHighEntropyValues(['platform', 'architecture']); return (h.platform || '') + '/' + (h.architecture || ''); } } catch (e) { }
  const ua = navigator.userAgent || '';
  return /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
}
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }

export async function hardwareId(salt) {
  const parts = [await platform(), gpu(), navigator.hardwareConcurrency || 0, navigator.deviceMemory || 0,
    (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), Math.max(screen.width, screen.height) * Math.min(screen.width, screen.height) > 0 && /Android|iPhone|iPad/.test(navigator.userAgent) ? `${Math.min(screen.width, screen.height)}x${Math.max(screen.width, screen.height)}` : ''];
  return (await sha(salt + '|' + parts.join('|'))).slice(0, 32);
}

function idbGet() {
  return new Promise((res) => { try { const r = indexedDB.open('vr_store', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { try { const tx = r.result.transaction('kv', 'readonly').objectStore('kv').get(NAME); tx.onsuccess = () => res(tx.result || ''); tx.onerror = () => res(''); } catch (e) { res(''); } }; r.onerror = () => res(''); } catch (e) { res(''); } });
}
function idbSet(v) { try { const r = indexedDB.open('vr_store', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { try { r.result.transaction('kv', 'readwrite').objectStore('kv').put(v, NAME); } catch (e) { } }; } catch (e) { } }
function cookieGet() { const m = document.cookie.match(new RegExp('(?:^|; )' + NAME + '=([0-9a-f]{32})')); return m ? m[1] : ''; }
function cookieSet(v) { try { document.cookie = `${NAME}=${v}; path=/; max-age=${60 * 60 * 24 * 3650}; SameSite=Lax; Secure`; } catch (e) { } }

// id ПК: сохранённый (любое из 3 мест) или отпечаток железа; сохраняем во все места
export async function machineId(salt) {
  let v = '';
  try { v = localStorage.getItem(NAME) || ''; } catch (e) { }
  if (!/^[0-9a-f]{32}$/.test(v)) v = cookieGet();
  if (!/^[0-9a-f]{32}$/.test(v)) v = await idbGet();
  if (!/^[0-9a-f]{32}$/.test(v)) v = await hardwareId(salt);
  try { localStorage.setItem(NAME, v); } catch (e) { }
  cookieSet(v); idbSet(v);
  return v;
}
