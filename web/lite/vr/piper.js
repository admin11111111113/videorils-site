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
let _stored = new Set();

export function available() { return typeof WebAssembly !== 'undefined'; }
export async function refreshStored() { try { const L = await lib(); _stored = new Set(await L.stored()); } catch (e) { } return _stored; }
export function is_downloaded(voice) { return _stored.has(vid(voice)); }
export function voices_status() { return RU_VOICES.map(([v, g]) => ({ voice: v, gender: g, downloaded: is_downloaded(v) })); }
export async function download_voice(voice, progress) {
  if (!VOICE_SET.has(voice)) throw new Error(`unknown voice: ${voice}`);
  await refreshStored();
  if (is_downloaded(voice)) return vid(voice);
  const L = await lib();
  await L.download(vid(voice), (p) => { if (progress && p && p.total) progress(Math.floor(p.loaded * 100 / p.total)); });
  await refreshStored();
  return vid(voice);
}
// -> Blob WAV; length_scale как в Piper (>1 медленнее), через atempo без смены тона
export async function synth_wav(text, voice, length_scale = 1.0) {
  if (!VOICE_SET.has(voice)) voice = DEFAULT_VOICE;
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
