// Порт Api: финальный кадр-призыв (CTA + QR) — настройки и PIL-рендер _render_outro_png
// на canvas (app.py 12205–12748), ссылки/цвета/контраст.
import { C, log, vfs, pickFiles, path } from './core.js';
import { cssFont, loadFonts } from './fonts.js';
import { qrCanvas } from './qr.js';
import { Api } from './api_base.js';

const P = Api.prototype;

P.get_outro = function () {
  return { on: this.outro_on, text: this.outro_text, tg: this.outro_tg, site: this.outro_site, seconds: this.outro_seconds, voice: this.outro_voice,
    bg: this.outro_bg, color: this.outro_color, photo: this.outro_photo || '', photo_name: path.basename(this.outro_photo || ''), show: this.outro_show, collapsed: this.outro_collapsed };
};
P.set_outro_bg = function (bg) { this.outro_bg = ['color', 'gradient', 'blur', 'photo'].includes(bg) ? bg : 'color'; this._persist(); return { bg: this.outro_bg }; };
P._outro_preview_resp = async function (extra = null) {
  const resp = Object.assign({ ok: true }, extra || {});
  try { await this._render_outro_png('temp/outro_preview.png', null); await vfs.flush('temp/outro_preview.png'); this._outro_prev_tick = (this._outro_prev_tick || 0) + 1; resp.thumb = `temp/outro_preview.png?t=${this._outro_prev_tick}`; } catch (e) { }
  return resp;
};
P.set_outro_photo = function () {
  return pickFiles('image/*').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    const dst = 'assets/user/outro_photo' + (path.splitext(files[0].name)[1] || '.jpg').toLowerCase();
    for (const p of vfs.list('assets/user/outro_photo')) vfs.remove(p);
    vfs.write(dst, files[0]); await vfs.flush(dst);
    this.outro_photo = dst; this.outro_bg = 'photo'; this._persist();
    return await this._outro_preview_resp({ name: files[0].name });
  });
};
P.clear_outro_photo = async function () { this.outro_photo = ''; if (this.outro_bg === 'photo') this.outro_bg = 'color'; this._persist(); return await this._outro_preview_resp(); };
P.set_outro_color = function (hex) { this.outro_color = this._norm_hex(hex, this.outro_color); this.outro_bg = 'color'; this._persist(); return { ok: true, color: this.outro_color }; };
P.preview_outro = async function (text = null, tg = null, site = null, color = null) {
  if (text !== null && text !== undefined) this.outro_text = text;
  if (tg !== null && tg !== undefined) this.outro_tg = tg;
  if (site !== null && site !== undefined) this.outro_site = site;
  if (color !== null && color !== undefined) { this.outro_color = this._norm_hex(color, this.outro_color); this.outro_bg = 'color'; }
  try {
    await this._render_outro_png('temp/outro_preview.png', null); await vfs.flush('temp/outro_preview.png');
    this._outro_prev_tick = (this._outro_prev_tick || 0) + 1;
    return { ok: true, thumb: `temp/outro_preview.png?t=${this._outro_prev_tick}` };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 120) }; }
};
P.set_outro_on = function (on) { this.outro_on = !!on; this.outro_user_set = true; this._persist(); return { on: this.outro_on }; };
P.set_outro_collapsed = function (v) { this.outro_collapsed = !!v; this._persist(); return { ok: true, collapsed: this.outro_collapsed }; };
P.set_outro_text = function (text) { const nw = (text || '').trim(); if (nw !== (this.outro_text || '')) { this.outro_stress_text = ''; this.outro_stress_manual = []; } this.outro_text = nw; this._persist(); return { ok: true }; };
P.outro_stress = async function (text = null) {
  if (text !== null && text !== undefined) { const nw = (text || '').trim(); if (nw !== (this.outro_text || '')) { this.outro_text = nw; this.outro_stress_text = ''; this.outro_stress_manual = []; } }
  const txt = (this.outro_text || '').trim(); if (!txt) return { ok: false };
  if (!this.outro_stress_text) this.outro_stress_text = await this._mark_stress(txt);
  return { ok: true, stress: this.outro_stress_text, homographs: this._scene_homographs(txt) };
};
P.set_outro_stress = function (stress_text, manual_idxs = null) {
  const txt = (this.outro_text || '').trim(); const st = stress_text || '';
  if (Api._letters_only(st) !== Api._letters_only(txt)) return { ok: false };
  this.outro_stress_text = st;
  try { this.outro_stress_manual = [...new Set((manual_idxs || []).map(x => parseInt(x)).filter(x => !Number.isNaN(x)))].sort((a, b) => a - b); } catch (e) { this.outro_stress_manual = []; }
  this._persist(); return { ok: true };
};
P.preview_outro_audio = async function () {
  if (this.busy) return { ok: false, msg: this._t('processing') };
  const txt = (this.outro_text || '').trim(); if (!txt) return { ok: false, msg: this._t('hook_empty') };
  try {
    const [say, ks] = await this._merge_manual_stress(txt, this.outro_stress_text || '', this.outro_stress_manual || null);
    const out = 'temp/voice_preview.mp3';
    await this._synth_one(say, out, { keep_stress: ks }); await vfs.flush(out);
    const res = { ok: true, url: out };
    if (this.tts_engine === 'eleven') res.credits = await this.get_eleven_credits();
    return res;
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.set_outro_tg = function (s) { this.outro_tg = (s || '').trim(); this._persist(); return { ok: true }; };
P.set_outro_site = function (s) { this.outro_site = (s || '').trim(); this._persist(); return { ok: true }; };
P.set_outro_seconds = function (n) { const v = parseInt(n); this.outro_seconds = Number.isNaN(v) ? 4 : Math.max(3, Math.min(6, v)); this._persist(); return { seconds: this.outro_seconds }; };
P.set_outro_voice = function (on) { this.outro_voice = !!on; this._persist(); return { voice: this.outro_voice }; };
P.set_outro_show = function (which, on) { if (which in this.outro_show) { this.outro_show[which] = !!on; this._persist(); } return { show: this.outro_show }; };
Api._norm_tg_url = function (s) { s = (s || '').trim(); if (!s) return ''; if (s.startsWith('http')) return s; if (s.startsWith('@')) return 'https://t.me/' + s.slice(1); if (s.includes('t.me/')) return 'https://' + s.split('//').pop().replace(/^\/+/, ''); return 'https://t.me/' + s.replace(/^@+/, ''); };
Api._tg_display = function (s) { s = (s || '').trim(); if (!s) return ''; if (s.includes('t.me/')) return '@' + s.split('t.me/').pop().replace(/^\/+|\/+$/g, ''); if (s.startsWith('http')) return s; return '@' + s.replace(/^@+/, ''); };
Api._norm_url = function (s) { s = (s || '').trim(); if (!s) return ''; return s.startsWith('http') ? s : 'https://' + s; };
Api._site_display = function (s) { return (s || '').trim().replace('https://', '').replace('http://', '').replace(/\/+$/, ''); };
Api._hex_to_rgb = function (hx) { hx = (hx || '#0a1712').replace(/^#+/, ''); if (hx.length === 3) hx = [...hx].map(c => c + c).join(''); const v = [0, 2, 4].map(i => parseInt(hx.slice(i, i + 2), 16)); return v.some(Number.isNaN) ? [10, 23, 18] : v; };
Api._rel_luminance = function (rgb) { const [r, g, b] = rgb.map(c => c / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
P._outro_text_colors = function (bg) { if (Api._rel_luminance(bg) < 0.5) return [[255, 255, 255], [150, 110, 255], [0, 0, 0, 170]]; return [[16, 18, 24], [255, 255, 255], [255, 255, 255, 150]]; };
const css = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${(a ?? (c.length > 3 ? c[3] : 255)) / 255})`;

function canvasOf(W, H) { const c = new OffscreenCanvas(W, H); return [c, c.getContext('2d')]; }
function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
P._outro_solid = function (W, H, hex) {
  const base = Api._hex_to_rgb(hex); const [c, g] = canvasOf(W, H);
  g.fillStyle = css(base, 255); g.fillRect(0, 0, W, H);
  // маска: эллипс (светлый центр), размытие 200, края затемняем до alpha 85
  const [m, mg] = canvasOf(W, H); mg.fillStyle = '#000'; mg.fillRect(0, 0, W, H);
  mg.filter = 'blur(200px)'; mg.fillStyle = '#fff'; mg.beginPath(); mg.ellipse(W / 2, H / 2, W * 0.42, H * 0.45, 0, 0, Math.PI * 2); mg.fill();
  const md = mg.getImageData(0, 0, W, H).data; const id = g.getImageData(0, 0, W, H); const d = id.data;
  for (let i = 0; i < d.length; i += 4) { const a = (85 - Math.trunc(md[i] * 85 / 255)) / 255; d[i] = d[i] * (1 - a); d[i + 1] = d[i + 1] * (1 - a); d[i + 2] = d[i + 2] * (1 - a); }
  g.putImageData(id, 0, 0);
  return c;
};
P._outro_gradient = function (W, H) {
  const [c, g] = canvasOf(W, H);
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgb(40,32,68)'); gr.addColorStop(1, 'rgb(9,10,20)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  const [gl, gg] = canvasOf(W, H); gg.fillStyle = '#000'; gg.fillRect(0, 0, W, H); gg.filter = 'blur(220px)';
  gg.fillStyle = 'rgb(96,70,190)'; gg.beginPath(); gg.ellipse(W / 2, (90 + 1180) / 2, 560, 545, 0, 0, Math.PI * 2); gg.fill();
  gg.fillStyle = 'rgb(28,92,150)'; gg.beginPath(); gg.ellipse(W / 2, (980 + 1800) / 2, 400, 410, 0, 0, Math.PI * 2); gg.fill();
  // point(p*0.55) + screen
  const gd = gg.getImageData(0, 0, W, H).data; const id = g.getImageData(0, 0, W, H); const d = id.data;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const b = Math.trunc(gd[i + k] * 0.55); d[i + k] = 255 - ((255 - d[i + k]) * (255 - b)) / 255; }
  g.putImageData(id, 0, 0);
  return c;
};
P._qr_card = async function (g, W, H, url, cx, cy, qpx, label, labf, light_bg = false) {
  const pad = 38; const card = qpx + pad * 2; const x = Math.trunc(cx - card / 2), y = Math.trunc(cy);
  g.save(); g.filter = 'blur(26px)'; g.fillStyle = `rgba(0,0,0,${(light_bg ? 190 : 150) / 255})`; rrect(g, x, y + 18, card, card, 40); g.fill(); g.restore();
  g.save(); g.filter = `blur(${light_bg ? 4 : 10}px)`; g.strokeStyle = light_bg ? 'rgba(20,24,32,0.92)' : 'rgba(140,185,255,0.82)'; g.lineWidth = 8; rrect(g, x - 9, y - 9, card + 18, card + 18, 46); g.stroke(); g.restore();
  g.fillStyle = '#fff'; rrect(g, x, y, card, card, 40); g.fill();
  const qr = await qrCanvas(url, qpx); g.imageSmoothingEnabled = false; g.drawImage(qr, x + pad, y + pad); g.imageSmoothingEnabled = true;
  if (label) {
    g.font = labf; const lw = g.measureText(label).width; g.textBaseline = 'top';
    g.fillStyle = light_bg ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.47)'; g.fillText(label, cx - lw / 2 + 2, y + card + 20 + 2);
    g.fillStyle = light_bg ? 'rgb(16,18,24)' : '#fff'; g.fillText(label, cx - lw / 2, y + card + 20);
  }
  return card;
};
P._badge = function (g, W, kind, txt, y, labf, labSize) {
  g.font = labf; const tw = g.measureText(txt).width; const icon = 52, bh = 96; const bw = Math.trunc(icon + 22 + tw + 84); const x = Math.trunc((W - bw) / 2);
  const col = kind === 'tg' ? 'rgb(40,159,217)' : 'rgb(76,175,80)';
  g.save(); g.filter = 'blur(16px)'; g.fillStyle = 'rgba(0,0,0,0.47)'; rrect(g, x, y + 12, bw, bh, bh / 2); g.fill(); g.restore();
  g.fillStyle = col; rrect(g, x, y, bw, bh, bh / 2); g.fill();
  const ix = x + 40, iy = y + bh / 2;
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 4;
  if (kind === 'tg') { g.beginPath(); g.moveTo(ix - 4, iy - 20); g.lineTo(ix + 44, iy); g.lineTo(ix - 4, iy + 20); g.lineTo(ix + 12, iy); g.closePath(); g.fill(); }
  else { g.beginPath(); g.ellipse(ix + 18, iy, 24, 22, 0, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(ix - 6, iy); g.lineTo(ix + 42, iy); g.stroke(); g.beginPath(); g.ellipse(ix + 18, iy, 10, 22, 0, 0, Math.PI * 2); g.stroke(); }
  g.textBaseline = 'top'; g.fillStyle = '#fff'; g.fillText(txt, x + icon + 34, y + (bh - labSize) / 2 - 4);
  return bh;
};
// -> Blob PNG в vfs path; bgFrame — ImageBitmap/канвас последнего кадра (фон «размытый кадр»)
P._render_outro_png = async function (p, bg_frame = null) {
  await loadFonts();
  const W = 1080, H = 1920; let base = null, photo_mode = false; let bg_rgb = [20, 18, 30];
  if (this.outro_bg === 'photo' && this.outro_photo && (vfs.exists(this.outro_photo) || await vfs.restore(this.outro_photo))) {
    try {
      const bmp = await createImageBitmap(vfs.read(this.outro_photo)); const [c, g] = canvasOf(W, H);
      const sc = Math.max(W / bmp.width, H / bmp.height); const dw = bmp.width * sc, dh = bmp.height * sc;
      g.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh); base = c; photo_mode = true;
    } catch (e) { base = null; }
  } else if (this.outro_bg === 'color') { base = this._outro_solid(W, H, this.outro_color); bg_rgb = Api._hex_to_rgb(this.outro_color); }
  else if (this.outro_bg === 'blur' && bg_frame) {
    try { const [c, g] = canvasOf(W, H); g.filter = 'blur(42px)'; g.drawImage(bg_frame, 0, 0, W, H); g.filter = 'none'; g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, W, H); base = c; } catch (e) { base = null; }
  }
  if (!base) base = this._outro_gradient(W, H);
  const [txt_col, glow_col, shadow_col] = this._outro_text_colors(bg_rgb);
  const light_bg = Api._rel_luminance(bg_rgb) >= 0.5;
  const [img, g] = canvasOf(W, H); g.drawImage(base, 0, 0);
  const font = (sz) => cssFont('Arial Black', sz);
  const tw = (s, f) => { g.font = f; return g.measureText(s).width; };
  const wrap = (s, f, maxw) => { const lines = []; let cur = ''; for (const w of s.split(/\s+/).filter(Boolean)) { const test = (cur + ' ' + w).trim(); if (tw(test, f) <= maxw || !cur) cur = test; else { lines.push(cur); cur = w; } } if (cur) lines.push(cur); return lines; };
  const block_glow = (lines, f, size, y, lh = 1.3) => {
    g.textBaseline = 'top';
    g.save(); g.filter = 'blur(18px)'; let yy = y; g.font = f; g.fillStyle = css(glow_col, 235);
    for (const ln of lines) { g.fillText(ln, (W - tw(ln, f)) / 2, yy); yy += Math.trunc(size * lh); } g.restore();
    yy = y; for (const ln of lines) { const x = (W - tw(ln, f)) / 2; g.font = f; g.fillStyle = css(shadow_col); g.fillText(ln, x + 2, yy + 4); g.fillStyle = css(txt_col, 255); g.fillText(ln, x, yy); yy += Math.trunc(size * lh); }
    return yy;
  };
  let y = 140; const _otext = (this.outro_text || '').trim();
  const lines = _otext ? wrap(_otext, font(80), W - 150) : [];
  if (lines.length) {
    if (photo_mode) { const f80 = font(80); const bh_ = Math.trunc(lines.length * 80 * 1.3); const bw_ = Math.trunc(Math.max(...lines.map(l => tw(l, f80)))) + 96; const bx_ = Math.trunc((W - bw_) / 2); g.fillStyle = 'rgba(10,7,18,0.63)'; rrect(g, bx_, y - 28, bw_, bh_ + 36, 36); g.fill(); }
    y = block_glow(lines, font(80), 80, y) + 44;
  }
  const tg_url = Api._norm_tg_url(this.outro_tg), site_url = Api._norm_url(this.outro_site);
  const qrs = []; if (tg_url && this.outro_show.tg_qr) qrs.push(['Телеграм', tg_url]); if (site_url && this.outro_show.site_qr) qrs.push(['Сайт', site_url]);
  const labf = font(46); const qy = Math.max(Math.trunc(y) + 8, 560);
  try {
    if (qrs.length === 2) { const qpx = 372, gap = 86; const card = qpx + 76; const cx0 = Math.trunc((W - (card * 2 + gap)) / 2) + Math.trunc(card / 2); for (let i = 0; i < 2; i++) await this._qr_card(g, W, H, qrs[i][1], cx0 + i * (card + gap), qy, qpx, qrs[i][0], labf, light_bg); }
    else if (qrs.length === 1) await this._qr_card(g, W, H, qrs[0][1], W / 2, qy, 560, null, labf, light_bg);
  } catch (e) { log(`  ⚠ QR не сгенерился: ${e.message || e}`); }
  let by = 1636; const bf = font(48);
  if (tg_url && this.outro_show.tg_nick) by += this._badge(g, W, 'tg', Api._tg_display(this.outro_tg), by, bf, 48) + 20;
  if (site_url && this.outro_show.site_link) this._badge(g, W, 'site', Api._site_display(this.outro_site), by, bf, 48);
  const blob = await img.convertToBlob({ type: 'image/png' });
  if (p) vfs.write(p, blob);
  return img;
};
