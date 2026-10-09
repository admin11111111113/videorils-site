// Видеорилс Лайт — веб. Точка входа: собирает Api из модулей и подменяет pywebview.
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
import './api_logo.js';
import './api_media.js';
import './api_extra.js';
import './api_batch.js';
import './api_cover.js';
import './api_clipmix.js';
import './api_am.js';
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
        if (typeof k === 'string' && !k.startsWith('_') && k !== 'then') return (...a) => { console.error('api missing: ' + k); return Promise.reject(new Error('api missing: ' + k)); };
        return undefined;
      },
    }),
  };
  // перетаскивание видео в «Из видео» (как setup_drag_drop)
  const bindDrop = () => {
    const dz = document.getElementById('dropzone');
    if (dz && !dz.__vrDrop) {
      dz.__vrDrop = true;
      dz.addEventListener('dragover', (e) => e.preventDefault());
      dz.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) api.on_drop(f); });
    }
    // #amDrop — «Автомонтаж» (готовое видео под обработку)
    const ad = document.getElementById('amDrop');
    if (ad && !ad.__vrDrop) {
      ad.__vrDrop = true;
      ad.addEventListener('dragover', (e) => e.preventDefault());
      ad.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { try { window.amDropped && window.amDropped(api.am_set_video(f)); } catch (er) { } } });
    }
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
