// Порт Api (Лайт): мелкие функции — микшер, иконки, «только субтитры» (строки/видео), обложка-хук
// вкл/выкл, ударения хука нарезки, серия, просмотр/правка роликов пакета, скорость готового рилса.
import { C, log, vfs, path, now, bar, call_js, strftime , mimeOf } from './core.js';
import { build_ass, clean_phrase } from './textutil.js';
import * as A from './audio.js';
import { Api } from './api_base.js';

const P = Api.prototype;

P.preview_mix_auto = async function () {
  const tracks = this._collect_tracks(); let p = ''; const cur = this._get_cur_music();
  if (cur && cur !== '__random__') p = tracks.find(t => t.toLowerCase() === cur.toLowerCase()) || '';
  if (!p && tracks.length) p = tracks[0];
  if (p) return await this.preview_mix(p);
  try {
    const vo = 'temp/mix_preview.mp3';
    await this._synth_one('Привет! Это мой голос для канала.', vo);
    const vv = Math.max(0, (this.voice_vol ?? 100) / 100);
    if (vv !== 1.0) { const b = await A.decode(vo); for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= vv; } vfs.write(vo, A.wav(b)); }
    await vfs.flush(vo);
    return { ok: true, url: 'temp/mix_preview.mp3' };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.set_platform_icons = function (on) { this.platform_icons = !!on; this._persist(); return { platform_icons: this.platform_icons }; };
// распознанные фразы для построчного редактора «Только субтитры»
P.get_foreign_segments = function () {
  const segs = [];
  for (const s of (this.foreign_segments || [])) { try { segs.push({ start: Math.round(Number(s.start || 0) * 100) / 100, end: Math.round(Number(s.end || 0) * 100) / 100, text: (s.text || '').trim() }); } catch (e) { } }
  return { segments: segs, n: segs.length, lang: this._foreign_lang || '' };
};
P.get_foreign_video_url = async function () {
  try {
    const src = this._audio_path_for('foreign');
    if (!(src && vfs.exists(src)) || !this._is_video_file(src)) return { ok: false };
    let ext = path.splitext(src)[1].toLowerCase(); if (!['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) ext = '.mp4';
    const dst = 'temp/subs_src' + ext; vfs.copy(src, dst); await vfs.flush(dst);
    return { ok: true, url: 'temp/subs_src' + ext + '?t=' + Math.trunc(now()) };
  } catch (e) { return { ok: false }; }
};
P.set_hook_cover = function (on) { this.hook_cover = !!on; this._persist(); return { on: this.hook_cover }; };
P.get_hook_cover = function () { return { on: !!(this.hook_cover ?? true) }; };
// ударения хука нарезки: строим по АКТУАЛЬНОМУ тексту поля (text с фронта)
P.hook_stress = async function (text = null) {
  if (text !== null && text !== undefined) {
    const nw = String(text || '').trim().slice(0, 120);
    if (nw !== (this.clipmix_hook || '')) { this.clipmix_hook = nw; this.clipmix_hook_stress = ''; this.clipmix_hook_stress_manual = []; }
  }
  const t = (this.clipmix_hook || '').trim(); if (!t) return { ok: false };
  if (!this.clipmix_hook_stress) this.clipmix_hook_stress = await this._mark_stress(t);
  return { ok: true, stress: this.clipmix_hook_stress, homographs: this._scene_homographs(t) };
};
P.set_hook_stress = function (stress_text, manual_idxs = null) {
  const t = (this.clipmix_hook || '').trim(); const st = stress_text || '';
  if (Api._letters_only(st) !== Api._letters_only(t)) return { ok: false };
  this.clipmix_hook_stress = st;
  try { this.clipmix_hook_stress_manual = [...new Set((manual_idxs || []).map(x => parseInt(x)).filter(x => !Number.isNaN(x)))].sort((a, b) => a - b); } catch (e) { this.clipmix_hook_stress_manual = []; }
  this._persist();
  return { ok: true };
};
// прослушка хука нарезки тем же движком/ударениями, что пойдут в сборку
P.preview_hook = async function () {
  if (this.busy) return { ok: false, msg: this._t('processing') };
  const hook = (this.clipmix_hook || '').trim(); if (!hook) return { ok: false, msg: this._t('hook_empty') };
  try {
    const [say, ks] = await this._merge_manual_stress(hook, this.clipmix_hook_stress || '', this.clipmix_hook_stress_manual || null);
    const out = 'temp/voice_preview.mp3';
    await this._synth_one(say, out, { keep_stress: ks }); await vfs.flush(out);
    const res = { ok: true, url: 'temp/voice_preview.mp3' };
    if (this.tts_engine === 'eleven') res.credits = await this.get_eleven_credits();
    return res;
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
// порядок серии (тизер-концовки «а завтра про …»)
P.set_series = function (items) {
  this._series = (items || []).map(x => String(x).trim()).filter(Boolean);
  if (!this._series_gender) this._series_gender = this._pick_series_gender(this._series_theme || '');
  return { ok: true, n: this._series.length };
};
P.reel_play = async function (idx) {
  idx = parseInt(idx); if (Number.isNaN(idx) || !(idx >= 0 && idx < this._batch_results.length)) return { ok: false };
  const src = this._batch_results[idx].path;
  if (!src || !vfs.exists(src)) return { ok: false, msg: this._t('file_not_selected') };
  const dst = `temp/reel_play_${idx}.mp4`; if (src !== dst) vfs.copy(src, dst); await vfs.flush(dst);
  this._thumb_tick++;
  return { ok: true, kind: 'video', url: `temp/reel_play_${idx}.mp4?t=${this._thumb_tick}` };
};
P.reel_edit = function (idx) {
  idx = parseInt(idx); if (Number.isNaN(idx) || !(idx >= 0 && idx < this._batch_results.length)) return { ok: false };
  const script = this._batch_results[idx].script || '';
  if (!script) return { ok: false, msg: this._t('paste_reel_answer') };
  const res = this.parse_to_scenes(script);
  return { ok: true, scenes: res.scenes || [], caption: res.caption || '', tags: res.tags || '' };
};
// 1.0-мастер рилса для переключателя скорости (превью всегда 1.0, скорость — playbackRate)
P._ensure_reel_master = function () {
  const lr = this.last_reel || '';
  if (lr && vfs.exists(lr) && lr !== (this._reel_speed_saved || '') && lr !== (this._reel_orig_path || '')) {
    this._reel_orig_path = lr;
    const mp = 'temp/reel_speed_master' + (path.splitext(lr)[1] || '.mp4');
    if (vfs.copy(lr, mp)) this._reel_master_path = mp; else this._reel_master_path = lr;
    this._reel_speed_saved = '';
  }
  return this._reel_master_path || lr;
};
// готовый ролик в плеер — ПРЯМОЙ blob-ссылкой из памяти: без SW и хранилища браузера
// (у части браузеров видео через SW не грузилось — плеер 0:00). Прошлую ссылку освобождаем.
function _blobUrlOf(api, src) {
  const b = vfs.read(src); if (!b) return '';
  try { if (api._preview_blob_url) URL.revokeObjectURL(api._preview_blob_url); } catch (e) { }
  api._preview_blob_url = URL.createObjectURL(b.type ? b : new Blob([b], { type: mimeOf(src) }));
  return api._preview_blob_url;
}
P.get_reel_preview_url = async function () {
  try {
    this._ensure_reel_master();
    const src = this._reel_master_path || this.last_reel || ''; if (!src || !vfs.exists(src)) return { ok: false };
    const url = _blobUrlOf(this, src); if (!url) return { ok: false };
    return { ok: true, url };
  } catch (e) { return { ok: false }; }
};
// «Сохранить в галерею» на выбранной скорости: setpts=PTS/N + atempo=N (тон сохраняется)
P.save_reel_speed = async function (mult = 1.0) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  mult = parseFloat(mult); if (Number.isNaN(mult)) mult = 1.0; mult = Math.max(0.5, Math.min(2.0, mult));
  const master = this._ensure_reel_master(); const orig = this._reel_orig_path || '';
  if (!(master && vfs.exists(master)) || !orig) return { ok: false, msg: this._t('extract_no_reel') };
  const prev = this._reel_speed_saved || ''; const ext = path.splitext(orig)[1] || '.mp4';
  const base = path.splitext(path.basename(orig))[0];
  if (Math.abs(mult - 1.0) < 0.005) {
    const target = orig;
    if (!vfs.exists(target)) vfs.copy(master, target);
    if (prev && prev !== target && vfs.exists(prev)) vfs.remove(prev);
    this._reel_speed_saved = target; this.last_reel = target;
    return { ok: true, speed: 1.0, name: path.basename(target) };
  }
  const tag = mult.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const target = `output/${base}_x${tag}${ext}`;
  try {
    const { retime } = await import('./engine.js');
    const blob = await retime(vfs.read(master), mult);
    vfs.write(target, blob); await vfs.flush(target);
  } catch (e) { return { ok: false, msg: this._t('save_speed_fail', String(e.message || e).slice(0, 60)) }; }
  if (!vfs.size(target)) return { ok: false, msg: this._t('save_speed_fail_generic') };
  for (const f of new Set([orig, prev])) if (f && f !== target && vfs.exists(f)) vfs.remove(f);
  this._reel_speed_saved = target; this.last_reel = target;
  log(`💾 В галерею сохранён ролик на скорости ${tag}×: ${path.basename(target)}`);
  return { ok: true, speed: mult, name: path.basename(target) };
};
// звук ролика (голос + музыка) — последний собранный или idx-й ролик пакета
P.extract_audio = async function (idx = null) {
  let src = '';
  if (idx !== null && idx !== undefined) { const i = parseInt(idx); const br = this._batch_results || []; if (i >= 0 && i < br.length) src = br[i].path || ''; }
  if (!src) src = this.last_reel || '';
  if (!src || !vfs.exists(src)) return { ok: false, msg: this._t('extract_no_reel') };
  try {
    const buf = await A.decode(src); const name = path.splitext(path.basename(src))[0] + '_audio.wav';
    const out = 'output/' + name; vfs.write(out, A.wav(buf));
    const u = URL.createObjectURL(vfs.read(out)); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
    log(`🎵 Звук сохранён: ${name}`);
    return { ok: true, path: out, name };
  } catch (e) { log(`  ⚠ извлечение звука не удалось: ${String(e.message || e).slice(0, 60)}`); return { ok: false, msg: this._t('extract_fail') }; }
};

// 📝 «Только субтитры»: СВОЁ видео без изменений + прожиг субтитров из (правленого) текста
P.build_subs_only = function (rows) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  const src = this._audio_path_for('foreign');
  if (!(src && vfs.exists(src))) return { ok: false, msg: this._t('select_audio_first') };
  if (!this._is_video_file(src)) return { ok: false, msg: this._t('subs_need_video') };
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  const segs = [];
  for (const r of (rows || [])) {
    const st = parseFloat(r.start), en = parseFloat(r.end); if (Number.isNaN(st) || Number.isNaN(en)) continue;
    const txt = clean_phrase(String(r.text || '').trim());
    if (txt && en > st) segs.push({ start: st, end: en, text: txt });
  }
  if (!segs.length) return { ok: false, msg: this._t('subs_no_text') };
  this._subs_only_worker(src, segs);
  return { ok: true };
};
P._subs_only_worker = async function (src, segs) {
  this.busy = true;
  try {
    bar(5, 'Готовлю видео…');
    const { renderReel } = await import('./engine.js'); const { mediaInfo } = await import('./thumbs.js');
    const info = await mediaInfo(src); const w = (info.w || 1080) & ~1, h = (info.h || 1920) & ~1; const dur = info.dur || 0;
    let voice; try { voice = await A.decode(src); } catch (e) { voice = A.silence(Math.max(0.5, dur), 44100, 2); }
    const rstyle = Object.assign({}, C.STYLES[this.reel_style % C.STYLES.length]);
    rstyle.size = Math.max(40, Math.trunc(h * this.sub_fontpct));
    const [al, mv] = this._sub_align_marginv(h, rstyle.size); rstyle.align = al; rstyle.marginv = mv; rstyle.marginl = 100; rstyle.marginr = 100;
    bar(35, 'Субтитры…');
    const ass = build_ass('temp/subsonly.ass', segs, rstyle, w, h, {}, null, null, 2);
    bar(55, 'Прожиг субтитров (звук без изменений)…');
    const logo = await this._logo_spec(w, h);
    const res = await renderReel({ W: w, H: h, clips: [{ kind: 'video', blob: vfs.read(src), frames: Math.max(1, Math.round(Math.max(dur, voice.duration) * 30)) }], voice, ass, logo, fit: { r: 1, trimTo: null },
      metaTitle: 'VideoRils Lite', onProgress: (f) => bar(55 + Math.trunc(f * 40), `Прожиг ${Math.trunc(f * 100)}%…`) });
    const out_name = `subs_${strftime('%m%d_%H%M%S')}${res.ext}`;
    const fin = `output/${out_name}`; vfs.write(fin, res.blob); await vfs.flush(fin);
    this.last_reel = fin;
    log(`✅ Готово (только субтитры): ${out_name}`);
    this._ping_render();
    if (!this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    bar(100, 'Готово');
    call_js('subsDone', fin, '');
  } catch (e) { log(`✖ Только субтитры: ${e.message || e}`); call_js('subsDone', '', String(e.message || e).slice(0, 160)); }
  finally { this.busy = false; }
};
