// Видео, которое браузер не может прочитать (HEVC/HDR с iPhone на старом ПК, ProRes и т.п.),
// переводим в обычный MP4 (H.264) встроенным ffmpeg (ffmpeg.wasm). Управляющая часть лежит у нас
// (vr/ffmpeg/ — браузер не запускает чужой worker), сам движок (~32 МБ) — с CDN, один раз и только
// при первой такой конвертации. Медленно (без видеокарты), поэтому — лишь когда иначе никак.
import { FFmpeg } from './ffmpeg/ffmpeg/index.js';
import { toBlobURL } from './ffmpeg/util/index.js';

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
let _ff = null;

async function engine() {
  if (_ff) return _ff;
  const f = new FFmpeg();
  await f.load({
    coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  _ff = f;
  return f;
}

// File/Blob -> Blob MP4 (H.264 + AAC), не больше 1080 по ширине, 8 бит (HDR -> обычный цвет).
// onProgress(доля 0..1) — для подсказки «перевожу… N%».
export async function toCompatibleMp4(file, onProgress) {
  const f = await engine();
  const onp = ({ progress }) => { try { if (onProgress && progress >= 0 && progress <= 1) onProgress(progress); } catch (e) { } };
  f.on('progress', onp);
  try {
    await f.writeFile('in', new Uint8Array(await file.arrayBuffer()));
    const code = await f.exec(['-i', 'in', '-vf', "scale='min(1080,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'out.mp4']);
    if (code !== 0) throw new Error('ffmpeg ' + code);
    const data = await f.readFile('out.mp4');
    return new Blob([data], { type: 'video/mp4' });
  } finally {
    f.off('progress', onp);
    try { await f.deleteFile('in'); } catch (e) { }
    try { await f.deleteFile('out.mp4'); } catch (e) { }
  }
}
