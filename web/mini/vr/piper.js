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
let _stored = new Set();

async function piperDir() { return await (await navigator.storage.getDirectory()).getDirectoryHandle('piper', { create: true }); }

export function available() { return typeof WebAssembly !== 'undefined'; }
// Скачанным считаем голос, только если модель и её json ЦЕЛЫЕ. Библиотека не ждёт окончания
// записи в OPFS (download() возвращается раньше), и закрытая во время записи вкладка оставляла
// пустую модель, которая числилась «скачанной» навсегда — Piper не работал никогда. Битое удаляем.
export async function refreshStored() {
  const ok = new Set();
  try {
    const dir = await piperDir();
    const sizes = {};
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      if (name.endsWith('.crswap')) { try { await dir.removeEntry(name); } catch (e) { } continue; }
      try { sizes[name] = (await h.getFile()).size; } catch (e) { sizes[name] = 0; }
    }
    for (const [v] of RU_VOICES) {
      const m = sizes[`${vid(v)}.onnx`], j = sizes[`${vid(v)}.onnx.json`];
      if (m >= MIN_MODEL && j > 0) { ok.add(vid(v)); continue; }
      for (const n of [`${vid(v)}.onnx`, `${vid(v)}.onnx.json`]) if (n in sizes) { try { await dir.removeEntry(n); } catch (e) { } }
    }
  } catch (e) { }
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
export async function download_voice(voice, progress) {
  if (!VOICE_SET.has(voice)) throw new Error(`unknown voice: ${voice}`);
  await refreshStored();
  if (is_downloaded(voice)) return vid(voice);
  const dir = await piperDir();
  const [mUrl, jUrl] = files(voice);
  // сначала json, модель — последней: по её размеру решаем «скачано ли»
  for (const [url, prog] of [[jUrl, null], [mUrl, (g, t) => progress && progress(Math.floor(g * 100 / t))]]) {
    const blob = await fetchBlob(url, prog);
    const w = await (await dir.getFileHandle(url.split('/').pop(), { create: true })).createWritable();
    await w.write(blob); await w.close();          // ЖДЁМ запись до конца
  }
  await refreshStored();
  if (!is_downloaded(voice)) throw new Error('голос не сохранился (нет места в браузере?)');
  return vid(voice);
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
