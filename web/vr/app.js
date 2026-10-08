// Видеорилс Мини — веб. Точка входа: собирает Api из модулей и подменяет pywebview.
import { vfs, log } from './core.js';
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

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 3000); });
    }
    return reg;
  } catch (e) { console.warn('SW', e); }
}

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
  window.dispatchEvent(new Event('pywebviewready'));
}
boot().catch(e => { console.error(e); log('✖ запуск: ' + (e.message || e)); });
