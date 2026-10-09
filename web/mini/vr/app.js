// Видеорилс Мини — веб. Точка входа: собирает Api из модулей и подменяет pywebview.
import { vfs, log, restoreStore } from './core.js';
import { Api } from './api_base.js';
import './api_settings.js';
import './api_voice.js';
import './api_keys.js';
import './api_ai.js';
import './api_misc.js';
import './api_reel.js';
import './api_tts.js';
import './api_scenes.js';
import './api_build.js';
import './api_outro.js';
import './api_whisper.js';
import { sfxPreload } from './api_misc.js';
import { loadFonts } from './fonts.js';
import * as Piper from './piper.js';
import { installTrialUX } from './trial_ux.js';

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
    if (!navigator.serviceWorker.controller) {
      await navigator.serviceWorker.ready;
      await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 4000); });
      // первый заход: без контроллера temp/… не раздаётся — один раз перезагружаем страницу
      if (!navigator.serviceWorker.controller) {
        // и после Ctrl+F5 (жёсткое обновление отключает SW для вкладки): раньше перезагрузка была
        // ОДИН раз на вкладку — после неё ролик в плеере не показывался. Защита от цикла — не чаще раза в 30 с.
        try { const last = +sessionStorage.getItem('vr_sw_reload') || 0; if (Date.now() - last > 30000) { sessionStorage.setItem('vr_sw_reload', String(Date.now())); location.reload(); await new Promise(() => { }); } } catch (e) { }
      }
    }
    return reg;
  } catch (e) { console.warn('SW', e); }
}

// SW спрашивает файл, которого нет в Cache Storage (нет места в браузере) — отдаём из памяти
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'vfs-get' && e.ports && e.ports[0]) { let b = null; try { b = vfs.read(e.data.path); } catch (x) { } e.ports[0].postMessage(b || null); }
});

document.addEventListener('error', (e) => {
  const v = e.target; if (!v || v.tagName !== 'VIDEO' || !v.error) return;
  const why = { 1: 'прервано', 2: 'сеть', 3: 'не декодируется', 4: 'формат не поддерживается' }[v.error.code] || v.error.code;
  try { log(`  ⚠ плеер не смог показать видео: ${why} (${(v.currentSrc || v.src || '').slice(0, 60)})`); } catch (x) { }
}, true);

async function boot() {
  await registerSW();
  await vfs.purge(['temp/', 'output/', 'input/']);               // чистая сессия, как temp десктопа
  // пользовательские файлы прошлых сессий (музыка, фото финала, демо голосов)
  try {
    const c = await caches.open('vr-vfs-v1');
    for (const req of await c.keys()) {
      const base = new URL('../', import.meta.url).href;
      const rel = req.url.startsWith(base) ? req.url.slice(base.length) : '';
      if (rel.startsWith('assets/user/') || rel.startsWith('assets/voice_demos/')) await vfs.restore(rel);
    }
  } catch (e) { }
  await Promise.all([sfxPreload(), loadFonts(), Piper.refreshStored().catch(() => { })]);
  await restoreStore();                                          // ключи/лицензия: восстановить из копии
  const api = new Api();
  window.__vrApi = api;
  try { api.track_open(); } catch (e) { }
  window.pywebview = {
    api: new Proxy({}, {
      get: (t, k) => {
        if (typeof api[k] === 'function') return (...a) => { try { return Promise.resolve(api[k](...a)); } catch (e) { return Promise.reject(e); } };
        return undefined;
      },
    }),
  };
  // перетаскивание видео в «Из видео» (как setup_drag_drop)
  const bindDrop = () => {
    const dz = document.getElementById('dropzone'); if (!dz || dz.__vrDrop) return; dz.__vrDrop = true;
    dz.addEventListener('dragover', (e) => e.preventDefault());
    dz.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) api.on_drop(f); });
  };
  bindDrop(); new MutationObserver(bindDrop).observe(document.body, { childList: true, subtree: true });
  // Разблокировка звука: первый клик «прогревает» общий плеер (#player), чтобы озвучка,
  // пришедшая через несколько секунд, могла играть (политика автозапуска браузеров)
  const unlock = () => {
    const pl = document.getElementById('player');
    if (pl && !pl.__vrUnlocked) {
      pl.__vrUnlocked = true; pl.muted = true;
      pl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      pl.play().then(() => { pl.pause(); pl.muted = false; }).catch(() => { pl.muted = false; });
    }
  };
  document.addEventListener('pointerdown', unlock, { capture: true, once: true });
  installTrialUX(api);
  window.dispatchEvent(new Event('pywebviewready'));
}
boot().catch(e => { console.error(e); log('✖ запуск: ' + (e.message || e)); });
