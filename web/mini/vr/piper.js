// Порт piper_tts.py для браузера: те же 4 русских голоса rhasspy/piper-voices (medium),
// модель качается ОДИН РАЗ (хранится в OPFS браузера), синтез — onnxruntime-web.
import * as A from './audio.js';

export const RU_VOICES = [['irina', 'женский'], ['denis', 'мужской'], ['dmitri', 'мужской'], ['ruslan', 'мужской']];
export const VOICE_SET = new Set(RU_VOICES.map(v => v[0]));
export const DEFAULT_VOICE = 'irina';
export const PREVIEW_TEXT = 'Привет! Это пример голоса для озвучки ваших роликов.';
const LIB = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/+esm';   // +esm: jsdelivr переписывает импорт onnxruntime-web
let _lib = null;
const lib = () => (_lib = _lib || import(/* @vite-ignore */ LIB));
const vid = (v) => `ru_RU-${v}-medium`;
// те же файлы и имена, что читает библиотека (OPFS «piper/<имя файла>»)
const HF = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const files = (v) => [`${HF}/ru/ru_RU/${v}/medium/${vid(v)}.onnx`, `${HF}/ru/ru_RU/${v}/medium/${vid(v)}.onnx.json`];
const MIN_MODEL = 1 << 20;     // модель medium ~60 МБ; меньше 1 МБ — недописанный/пустой файл
const PART = '.part';          // пишем во временный файл, готовый — переименовываем
let _stored = new Set();
const _dl = new Map();         // голос -> идущая загрузка (не качаем параллельно, не чистим её файлы)
const _mem = new Set();        // голоса, которые браузер не дал сохранить — работают из памяти (до закрытия вкладки)

async function piperDir() { return await (await navigator.storage.getDirectory()).getDirectoryHandle('piper', { create: true }); }

export function available() { return typeof WebAssembly !== 'undefined'; }
// Скачанным считаем голос, только если модель и её json ЦЕЛЫЕ. Битое (пустое/недописанное —
// например, закрыли вкладку во время записи) удаляем, чтобы скачать заново. Файлы голоса, который
// СЕЙЧАС качается, не трогаем — иначе запись падала («state had changed since it was read»).
export async function refreshStored() {
  const ok = new Set();
  try {
    const dir = await piperDir();
    const sizes = {};
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      // файлы идущей загрузки (временный .part и голос в работе) не открываем — это и роняло запись
      if (name.endsWith(PART) || [..._dl.keys()].some((v) => name.startsWith(vid(v) + '.'))) continue;
      try { sizes[name] = (await h.getFile()).size; } catch (e) { sizes[name] = -1; }
    }
    for (const [v] of RU_VOICES) {
      const m = sizes[`${vid(v)}.onnx`], j = sizes[`${vid(v)}.onnx.json`];
      if (m >= MIN_MODEL && j > 0) { ok.add(vid(v)); continue; }
      if (_dl.has(v)) continue;                       // идёт загрузка — не мешаем
      for (const n of Object.keys(sizes)) if (n.startsWith(vid(v) + '.')) { try { await dir.removeEntry(n); } catch (e) { } }
    }
  } catch (e) { }
  for (const v of _mem) ok.add(vid(v));
  _stored = ok;
  return _stored;
}
export function is_downloaded(voice) { return _stored.has(vid(voice)); }
export function voices_status() { return RU_VOICES.map(([v, g]) => ({ voice: v, gender: g, downloaded: is_downloaded(v) })); }
async function fetchBlob(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url.split('/').pop()}`);
  const total = +(r.headers.get('Content-Length') || 0), rd = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (onProgress && total) onProgress(got, total); }
  if (total && got !== total) throw new Error('загрузка оборвалась');
  return new Blob(parts);
}
// запись целиком во временный файл -> переименование в готовое имя (move); нет move — пишем сразу
async function writeFile(dir, name, blob) {
  const tmp = await dir.getFileHandle(name + PART, { create: true });
  const w = await tmp.createWritable(); await w.write(blob); await w.close();
  if (typeof tmp.move === 'function') { try { await dir.removeEntry(name); } catch (e) { } await tmp.move(name); return; }
  const fin = await dir.getFileHandle(name, { create: true }); const w2 = await fin.createWritable(); await w2.write(blob); await w2.close();
  try { await dir.removeEntry(name + PART); } catch (e) { }
}
// модель в памяти страницы — когда хранилище браузера не дало записать: подсовываем её библиотеке
const _memBlobs = new Map();   // url -> Blob
let _fetchHooked = false;
function hookFetch() {
  if (_fetchHooked) return; _fetchHooked = true;
  const of = window.fetch.bind(window);
  window.fetch = (u, o) => { const url = String((u && u.url) || u); const b = _memBlobs.get(url); return b ? Promise.resolve(new Response(b)) : of(u, o); };
}
async function _download(voice, progress) {
  const [mUrl, jUrl] = files(voice);
  const jBlob = await fetchBlob(jUrl, null);
  const mBlob = await fetchBlob(mUrl, (g, t) => progress && progress(Math.floor(g * 100 / t)));
  try {
    const dir = await piperDir();
    await writeFile(dir, jUrl.split('/').pop(), jBlob);
    await writeFile(dir, mUrl.split('/').pop(), mBlob);   // модель — последней: по её размеру решаем «скачано ли»
  } catch (e) {
    // браузер не дал места/сбой хранилища — голос всё равно работает, из памяти (до закрытия вкладки)
    console.warn('Piper: модель не сохранилась в браузере, работаю из памяти:', e && (e.name || e.message));
    try { const dir = await piperDir(); for (const n of [jUrl, mUrl].map((u) => u.split('/').pop())) for (const x of [n, n + PART]) { try { await dir.removeEntry(x); } catch (z) { } } } catch (z) { }
    _memBlobs.set(jUrl, jBlob); _memBlobs.set(mUrl, mBlob); hookFetch(); _mem.add(voice);
  }
}
export function download_voice(voice, progress) {
  if (!VOICE_SET.has(voice)) return Promise.reject(new Error(`unknown voice: ${voice}`));
  // метку «качается» ставим СРАЗУ (синхронно): два быстрых нажатия иначе запускали две загрузки
  // в один и тот же файл -> NotFoundError/«state had changed»
  if (_dl.has(voice)) return _dl.get(voice);
  const job = (async () => {
    try {
      await refreshStored();
      if (is_downloaded(voice)) return vid(voice);
      await _download(voice, progress);
    } finally { _dl.delete(voice); }
    await refreshStored();
    if (!is_downloaded(voice)) throw new Error('голос не сохранился — попробуй ещё раз');
    return vid(voice);
  })();
  _dl.set(voice, job);
  return job;
}
// -> Blob WAV; length_scale как в Piper (>1 медленнее), через atempo без смены тона
export async function synth_wav(text, voice, length_scale = 1.0) {
  if (!VOICE_SET.has(voice)) voice = DEFAULT_VOICE;
  await download_voice(voice);                     // нет/битая модель -> скачать целиком, прежде чем читать
  const L = await lib();
  // своя сессия: WASM движка ONNX — той же мажорной версии и с того же CDN, что и сам модуль
  // (по умолчанию библиотека берёт 1.18 с cdnjs, а jsdelivr подтягивает 1.2x -> «no available backend»)
  const sess = await L.TtsSession.create({ voiceId: vid(voice), wasmPaths: {
    onnxWasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/',
    piperData: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
    piperWasm: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm' } });
  sess.voiceId = vid(voice);
  const wav = await sess.predict(text || '');
  if (Math.abs(length_scale - 1.0) < 0.01) return wav;
  const buf = await A.decode(wav);
  return A.wav(A.atempo(buf, 1.0 / length_scale));
}
