// Порт Api: логотип / водяной знак (Лайт) — choose_logo, _process_logo, настройки, превью.
// Файлы — в assets/user/ (Cache Storage, переживают перезагрузку, как assets/ десктопа).
import { vfs, path, pickFiles, blobToDataUrl } from './core.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const DST = 'assets/user/logo_processed.png';

// logo_processed.png: при removebg белый фон -> прозрачный (r,g,b>235 -> a=0; >215 -> a=90)
P._process_logo = async function () {
  const src = vfs.read(this.logo_src); if (!src) throw new Error('нет файла логотипа');
  const bmp = await createImageBitmap(src);
  const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  if (this.logo_removebg) {
    const im = ctx.getImageData(0, 0, c.width, c.height); const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 235 && g > 235 && b > 235) d[i + 3] = 0;
      else if (r > 215 && g > 215 && b > 215) d[i + 3] = 90;
    }
    ctx.putImageData(im, 0, 0);
  }
  vfs.write(DST, await c.convertToBlob({ type: 'image/png' })); await vfs.flush(DST);
  this.logo_path = DST;
  return DST;
};
P._logo_data_url = async function () {
  if (!(this.logo_path && vfs.exists(this.logo_path))) return '';
  return await blobToDataUrl(vfs.read(this.logo_path));
};
P.choose_logo = function () {
  return pickFiles('image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    const f = files[0];
    try {
      const ext = path.splitext(f.name)[1].toLowerCase() || '.png';
      const dst = 'assets/user/logo_src' + ext;
      for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.bmp']) { const p = 'assets/user/logo_src' + e; if (p !== dst && vfs.exists(p)) vfs.remove(p); }
      vfs.write(dst, f); await vfs.flush(dst);
      this.logo_src = dst;
      await this._process_logo();
      this._persist();
      return { ok: true, name: f.name, preview: await this._logo_data_url() };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  });
};
P.set_logo_removebg = async function (on) {
  this.logo_removebg = !!on;
  if (this.logo_src && vfs.exists(this.logo_src)) { try { await this._process_logo(); } catch (e) { return { ok: false, msg: String(e.message || e) }; } }
  this._persist();
  return { ok: true, preview: await this._logo_data_url() };
};
P.set_logo_xy = function (xpct, ypct) {
  const a = parseFloat(xpct), b = parseFloat(ypct);
  if (!Number.isNaN(a) && !Number.isNaN(b)) { this.logo_xpct = Math.max(0, Math.min(1, a)); this.logo_ypct = Math.max(0, Math.min(1, b)); this._persist(); }
  return { xpct: this.logo_xpct, ypct: this.logo_ypct };
};
P.set_logo_size = function (n) { const v = Math.round(parseFloat(n)); this.logo_size = Number.isNaN(v) ? 15 : Math.max(5, Math.min(60, v)); this._persist(); return this.logo_size; };
P.set_logo_opacity = function (n) { const v = Math.round(parseFloat(n)); this.logo_opacity = Number.isNaN(v) ? 90 : Math.max(30, Math.min(100, v)); this._persist(); return this.logo_opacity; };
P.set_logo_on = function (on) { this.logo_on = !!on; this._persist(); return this.logo_on; };
P.save_logo = function () { this._persist(); return { ok: true }; };
P.remove_logo = function () {
  for (const p of [this.logo_path, this.logo_src]) if (p && vfs.exists(p)) vfs.remove(p);
  this.logo_src = ''; this.logo_path = ''; this.logo_on = false; this._persist();
  return { ok: true };
};
P.get_logo_settings = async function () {
  if (this.logo_src && !this.logo_path && vfs.exists(this.logo_src)) { try { await this._process_logo(); } catch (e) { } }
  return { has: !!(this.logo_path && vfs.exists(this.logo_path)), name: this.logo_src ? path.basename(this.logo_src) : '',
    pos: this.logo_pos, xpct: this.logo_xpct, ypct: this.logo_ypct, size: this.logo_size, opacity: this.logo_opacity,
    on: this.logo_on, removebg: this.logo_removebg, preview: await this._logo_data_url() };
};
// _brand -> спецификация логотипа для движка (null — логотип выключен/нет файла)
P._logo_spec = async function (vw = 1080, vh = 1920) {
  if (this.logo_on && this.logo_src && vfs.exists(this.logo_src) && !(this.logo_path && vfs.exists(this.logo_path))) {
    try { await this._process_logo(); } catch (e) { }
  }
  if (!(this.logo_on && this.logo_path && vfs.exists(this.logo_path))) return null;
  const { makeLogo } = await import('./engine.js');
  return await makeLogo(vfs.read(this.logo_path), vw, vh, this.logo_size, this.logo_xpct, this.logo_ypct, this.logo_opacity);
};
