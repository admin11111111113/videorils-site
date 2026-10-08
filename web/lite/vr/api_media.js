// Порт Api: свои фото/видео рилса (режимы видеоряда auto | mine | mix | split), Лайт.
import { C, vfs, path, pickFiles } from './core.js';
import { makeThumb } from './thumbs.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const MEDIA_IMG = C['Api.MEDIA_IMG'], MEDIA_VID = C['Api.MEDIA_VID'];

P.set_reel_media_source = function (mode) { this.reel_media_source = ['mine', 'mix', 'split'].includes(mode) ? mode : 'auto'; return this.reel_media_source; };
P.add_reel_media = function () {
  return pickFiles('image/*,video/*,.jpg,.jpeg,.png,.webp,.bmp,.mp4,.mov,.mkv,.webm,.avi', true).then(async (files) => {
    if (!files) return await this.get_reel_media();
    for (const f of files) {
      const ext = path.splitext(f.name)[1].toLowerCase();
      if (![...MEDIA_IMG, ...MEDIA_VID].includes(ext)) continue;
      const p = `input/media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${f.name}`;
      vfs.write(p, f); this.reel_media.push(p);
    }
    return await this.get_reel_media();
  });
};
// кадр-превью в temp/ (первый кадр видео / уменьшенное фото)
P._media_thumb = async function (p, idx) {
  const out = `temp/mthumb_${idx}.jpg`;
  try { await makeThumb(p, out, 200); } catch (e) { return ''; }
  return out;
};
P.get_reel_media = async function () {
  const items = [];
  for (let i = 0; i < this.reel_media.length; i++) {
    const p = this.reel_media[i];
    items.push({ path: p, name: path.basename(p).replace(/^media_\d+_[a-z0-9]+_/, ''), type: this._is_video_file(p) ? 'video' : 'photo', thumb: await this._media_thumb(p, i) });
  }
  return { ok: true, source: this.reel_media_source, items };
};
P.move_reel_media = function (idx, delta) {
  const i = parseInt(idx), j = i + parseInt(delta);
  if (i >= 0 && i < this.reel_media.length && j >= 0 && j < this.reel_media.length) [this.reel_media[i], this.reel_media[j]] = [this.reel_media[j], this.reel_media[i]];
  return this.get_reel_media();
};
P.remove_reel_media = function (idx) { const i = parseInt(idx); if (i >= 0 && i < this.reel_media.length) this.reel_media.splice(i, 1); return this.get_reel_media(); };
P.clear_reel_media = function () { this.reel_media = []; return this.get_reel_media(); };
