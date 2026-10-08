// Порт Api (Лайт): АВТОМОНТАЖ — готовое видео -> Whisper -> ИИ-план (вырезки/наезды/вставки/ч-б/лупа)
// -> утверждение пользователем -> рендер -> второй проход ИИ по кадрам (vision) -> доп. правки.
import { C, log, re, vfs, path, call_js, now, strftime, shuffle, choice, pickFiles } from './core.js';
import * as A from './audio.js';
import { build_ass, clean_phrase, is_important } from './textutil.js';
import { _download, _wikimedia_search } from './media.js';
import { Api } from './api_base.js';
import * as AM from './amengine.js';

const P = Api.prototype;
const K = (n) => C['Api.' + n];
const VIDEO_EXT = K('_AM_VIDEO_EXT');
const SPLIT_TOP = C._AM_SPLIT_TOP_H, SPLIT_BOT = C._AM_SPLIT_BOT_H, SPLIT_BORDER = C._AM_SPLIT_BORDER, TILT_DEG = C._AM_TILT_DEG_PER_AMP;
const ZOOM_AMP = K('_AM_ZOOM_AMP'), ZOOM_WIDTH = K('_AM_ZOOM_WIDTH');
const ZOOM_MOTIONS = ['crash', 'ease', 'linear'];
const BASE = 'temp/am_base.mp4';

// ---------- модульные функции ----------
// whisper-слова -> фразы субтитров (разрыв по паузе > gap или max_words)
export function am_segments(words, max_words = 7, gap = 0.55) {
  const segs = [], wt = []; let cur = [];
  for (const [w, s, e] of words) {
    if (cur.length) { const pe = cur[cur.length - 1][2]; if ((s - pe) > gap || cur.length >= max_words) { segs.push({ start: cur[0][1], end: cur[cur.length - 1][2], text: cur.map(x => x[0]).join(' ') }); cur = []; } }
    cur.push([w, s, e]); wt.push([Number(s), Number(e)]);
  }
  if (cur.length) segs.push({ start: cur[0][1], end: cur[cur.length - 1][2], text: cur.map(x => x[0]).join(' ') });
  return [segs, wt];
}
const stripW = (w) => String(w || '').toLowerCase().replace(/^[.,!?:;»«"'()—–\-… ]+|[.,!?:;»«"'()—–\-… ]+$/g, '');
// эмодзи по слову — совпадение ТОЛЬКО с начала слова
export function am_emoji_for(word) {
  const w = stripW(word);
  if (w.length < 4 || C._AM_EMOJI_STOP.some(p => w.startsWith(p))) return null;
  for (const [emo, stems] of C.AM_EMOJI) if (stems.some(s => w.startsWith(s))) return emo;
  return null;
}
// платформа по слову («рилс/reels» НЕ триггерит Instagram)
export function platform_of_word(w) {
  w = stripW(w); if (!w) return null;
  if (w.startsWith('тикток') || w === 'tiktok') return 'tiktok';
  if (w.startsWith('ютуб') || ['youtube', 'shorts', 'шортс', 'шортсы', 'шортсов'].includes(w)) return 'youtube';
  if (w.startsWith('инстаграм') || ['инста', 'инсты', 'инсте', 'instagram'].includes(w)) return 'instagram';
  return null;
}

// ---------- приём файла / состояние ----------
P.am_pick_video = function () {
  return pickFiles('video/*,' + VIDEO_EXT.join(',')).then(files => files ? this.am_set_video(files[0]) : { ok: false, msg: this._t('file_not_selected') });
};
// и кнопка, и перетаскивание (#amDrop): отсекаем не-видео
P.am_set_video = function (file) {
  if (!file || !file.name) return { ok: false, msg: this._t('am_file_not_found') };
  if (!VIDEO_EXT.includes(path.splitext(file.name)[1].toLowerCase())) return { ok: false, msg: this._t('am_need_video_file') };
  const p = 'input/am_src_' + file.name; vfs.write(p, file);
  this._am_video = p;
  log(`  📥 Автомонтаж: выбрано видео ${file.name}`);
  return { ok: true, name: file.name };
};
P.am_get_state = function () {
  const v = this._am_video || '';
  return { has: !!(v && vfs.exists(v)), name: v ? path.basename(v).replace(/^am_src_/, '') : '', styles: this.get_styles(), opts: this._am_opts || {} };
};
P.am_set_opts = function (opts) { this._am_opts = Object.assign({}, opts || {}); return { ok: true }; };
P.am_process = function () {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (this.busy) return { ok: false, msg: this._t('am_busy') };
  if (!(this._am_video && vfs.exists(this._am_video))) return { ok: false, msg: this._t('am_no_video') };
  if ((this._am_opts || {}).ai_all && !this.gemini_key) return { ok: false, msg: this._t('am_ai_needs_gemini') };
  this.busy = true;
  this._am_state = { state: 'run', step: this._t('am_step_start') };
  this._am_worker();
  return { ok: true };
};
P.am_status = function () { return this._am_state || { state: 'none' }; };
P.am_result_url = async function () {
  try {
    const fn = (this._am_state || {}).file || ''; const src = fn ? 'output/' + fn : '';
    if (!(src && vfs.exists(src))) return { ok: false };
    const dst = 'temp/am_preview' + (path.splitext(src)[1] || '.mp4'); vfs.copy(src, dst); await vfs.flush(dst);
    return { ok: true, url: dst + '?t=' + Math.trunc(now()), file: fn };
  } catch (e) { return { ok: false }; }
};
P.am_source_url = function () { return vfs.exists(BASE) ? { ok: true, url: BASE + '?t=' + (this._am_base_tick || 0) } : { ok: false }; };
Api._am_segs_payload = function (segs) {
  const out = [];
  (segs || []).forEach((s, i) => { try { out.push({ i, start: Math.round(Number(s.start || 0) * 100) / 100, end: Math.round(Number(s.end || 0) * 100) / 100, text: clean_phrase(s.text || '').slice(0, 200) }); } catch (e) { } });
  return out;
};
// «Папка» в браузере = скачать готовый ролик
P.am_open_folder = function () {
  const fn = (this._am_state || {}).file || ''; const p = fn ? 'output/' + fn : '';
  if (!(p && vfs.exists(p))) return { ok: false, msg: this._t('extract_no_reel') };
  const u = URL.createObjectURL(vfs.read(p)); const a = document.createElement('a'); a.href = u; a.download = fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
  return { ok: true };
};
P._am_step = function (msg) { this._am_state = { state: 'run', step: msg }; try { call_js('amProgress', this._am_state); } catch (e) { } };

// ---------- ФАЗА 1: подготовка + распознавание + ИИ-план ----------
P._am_worker = async function () {
  try {
    const opts = Object.assign({}, this._am_opts || {});
    this._am_used = new Set(); this._am_reviewed = false; this._am_base_plan = null; this._am_seg_q = null; this._am_swap_state = {};
    this._am_step(this._t('am_step_prep_video'));
    await this._am_normalize(this._am_video);
    this._am_step(this._t('am_step_whisper'));
    const words = (await this._transcribe_words(BASE)) || [];
    const [segs, word_times] = words.length ? am_segments(words) : [[], []];
    log(`  ▶ Автомонтаж: ${words.length} слов, ${segs.length} фраз`);
    let plan = null; const dur = (await AM.videoDur(vfs.read(BASE))) || 0;
    const _cuts_on = opts.cuts ?? true; let probe = null;
    if (opts.ai_all) { this._am_step(this._t('am_step_video_type')); probe = await this._am_probe_content(BASE, dur); opts.broll = true; opts.zoom = true; }
    if (words.length && (opts.zoom || opts.broll || _cuts_on)) { this._am_step(this._t('am_step_ai_think')); plan = await this._am_plan(words, segs, dur, _cuts_on, probe); this._am_last_plan = plan; }
    if (plan) { const want_bw = probe ? (!!(plan.bw && plan.bw.length) || probe.kind === 'talking') : !!opts.bw_cam; await this._am_auto_extras(plan, BASE, dur, words, segs, opts, want_bw); }
    if (probe && plan) {
      opts.lens = !!plan.ai_lens || probe.kind === 'screencast'; opts.bw_cam = !!(plan.bw && plan.bw.length);
      log(`  🤖 ИИ решил: лупа=${opts.lens ? 'да' : 'нет'}, ч/б-отрезков=${(plan.bw || []).length}, вставок=${(plan.broll || []).length}`);
      this._am_opts = Object.assign({}, opts);
    }
    this._am_ctx = { base: BASE, words, segs, word_times, dur, opts };
    if (plan) {
      this._am_state = { state: 'plan', plan, dur: Math.round(dur * 10) / 10, segs: Api._am_segs_payload(segs) };
      call_js('amProgress', this._am_state);
      log('  ⏸ план готов — жду подтверждения пользователя');
      this.busy = false; return;
    }
    await this._am_render(plan);
  } catch (e) {
    log(`✖ Автомонтаж: ${e.message || e}`);
    this._am_state = { state: 'err', msg: String(e.message || e).slice(0, 160) };
    try { call_js('amProgress', this._am_state); } catch (e2) { }
    this.busy = false;
  }
};
// любой аспект -> 1080x1920 blur-letterbox @30fps + звук
P._am_normalize = async function (src) {
  const { renderReel } = await import('./engine.js');
  const blob = vfs.read(src); const dur = await AM.videoDur(blob);
  let voice; try { voice = await A.decode(blob); } catch (e) { voice = A.silence(Math.max(0.5, dur), 44100, 2); }
  const res = await renderReel({ W: 1080, H: 1920, clips: [{ kind: 'video', blob, frames: Math.max(1, Math.round(dur * 30)), fit: { blur: true, zoom: false } }], voice, fit: { r: 1, trimTo: null } });
  vfs.write(BASE, res.blob); await vfs.flush(BASE); this._am_base_tick = Math.trunc(now());
  return BASE;
};
P._am_plan_bw = function (items, dur) {
  const out = [];
  for (const w of (items || [])) {
    let t = Math.max(0, parseFloat(w.t)), d = Math.max(2, Math.min(8, parseFloat(w.dur ?? K('_AM_BW_LEN'))));
    if (Number.isNaN(t) || Number.isNaN(d)) continue;
    if (dur && t + d > dur) d = dur - t;
    if (d < 1.5 || t >= dur) continue;
    out.push({ t: Math.round(t * 100) / 100, dur: Math.round(d * 100) / 100, why: String(w.why || '').slice(0, 120), manual: !!w.manual, review: !!w.review });
    if (out.length >= 3) break;
  }
  return out.sort((a, b) => a.t - b.t);
};
P._am_auto_extras = async function (plan, base, dur, words, segs, opts, want_bw = null) {
  if (want_bw === null) want_bw = !!opts.bw_cam;
  if (want_bw && !(plan.bw && plan.bw.length)) {
    try {
      const faces = await this._am_face_scan(base, dur); const win = this._am_pick_bw_window(dur, faces, plan, words);
      if (win) { plan.bw = [win]; log(`  ◐ ч/б-отрезок @ ${win.t.toFixed(1)}с ×${win.dur.toFixed(1)}с — ${win.why}`); }
      else log('  ℹ места под ч/б-отрезок не нашлось — эффект пропущен');
    } catch (e) { log(`  ⚠ выбор ч/б-отрезка не удался (${String(e.message || e).slice(0, 60)})`); }
  }
  if (opts.broll && (plan.broll || []).length < K('_AM_BROLL_MIN')) {
    try {
      const add = await this._am_force_broll(plan, dur, segs);
      if (add.length) { plan.broll = (plan.broll || []).concat(add).sort((a, b) => a.t - b.t); log(`  🎬 b-roll был пуст — долил ${add.length} вставок механикой`); }
    } catch (e) { log(`  ⚠ доливка b-roll не удалась (${String(e.message || e).slice(0, 60)})`); }
  }
};
P._am_force_broll = async function (plan, dur, segs) {
  if (!segs.length) return [];
  const busy = (plan.cut || []).map(c => [Number(c.s || 0), Number(c.e || 0)]).concat((plan.broll || []).map(b => [Number(b.t || 0), Number(b.t || 0) + Number(b.dur || 2)]));
  const picked = [], seen = new Set();
  for (const share of [0.30, 0.65]) {
    const near = segs.reduce((a, s) => Math.abs(Number(s.start) - dur * share) < Math.abs(Number(a.start) - dur * share) ? s : a);
    const key = Math.round(Number(near.start) * 100) / 100; if (seen.has(key)) continue;
    const t = Math.round(Math.max(0.8, Math.min(dur - 2.8, Number(near.start) + 0.2)) * 100) / 100;
    if (t < 0.8 || busy.some(([bs, be]) => t < be + 0.5 && bs - 0.5 < t + 2.5)) continue;
    seen.add(key); picked.push([t, clean_phrase(near.text)]); busy.push([t, t + 2.5]);
  }
  if (!picked.length) return [];
  const qmap = (await this._am_broll_queries(picked.map(p => p[1]))) || {};
  const out = [];
  picked.forEach(([t, txt], i) => { const q = qmap[i]; if (!q || out.length >= 2) return; out.push({ t, dur: 2.5, q, layout: 'split', why: 'вставка обязательна в авто-плане', what: txt.slice(0, 60), src: txt.slice(0, 90) }); });
  return out;
};
// ФАЗА 2 по «Собрать»: утверждённый план -> та же валидация -> рендер
P.am_apply_plan = async function (plan = null) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (this.busy) return { ok: false, msg: this._t('am_busy') };
  if (!this._am_ctx) return { ok: false, msg: this._t('am_no_plan') };
  const dur = Number(this._am_ctx.dur || 0);
  const src = (plan && typeof plan === 'object') ? plan : (this._am_last_plan || {});
  const _cuts_on = (this._am_opts || {}).cuts ?? true;
  const _br = []; let _lost = 0;
  for (let b of (src.broll || [])) {
    b = Object.assign({}, b);
    if (b.clip) b.q = b.q || 'picked';
    else { b.q = await this._am_ru2en(b.q || ''); if (!b.q) { _lost++; log(`  ⚠ вставка @ ${Number(b.t || 0).toFixed(1)}с без запроса — пропущена (нечего искать)`); continue; } }
    _br.push(b);
  }
  if (_lost) this._am_warn = this._t('am_skip_warn', _lost);
  const clean = { cut: _cuts_on ? this._am_plan_cut(src.cut, dur) : [], zoom: this._am_plan_zoom(src.zoom, dur), broll: this._am_plan_broll(_br, dur), bw: this._am_plan_bw(src.bw, dur), lens: this._am_plan_bw(src.lens, dur) };
  this.busy = true;
  this._am_state = { state: 'run', step: this._t('am_step_assemble_plan') };
  log(`  ▶ план утверждён: вырезок ${clean.cut.length} (−${clean.cut.reduce((a, c) => a + c.e - c.s, 0).toFixed(1)}с), zoom ${clean.zoom.length}, b-roll ${clean.broll.length}`);
  this._am_render(clean);
  const _w = this._am_warn || ''; this._am_warn = '';
  return _w ? { ok: true, warn: _w } : { ok: true };
};
// ФАЗА 3: принятые доп. правки второго прохода — пересборка ОТ ИСХОДНИКА объединённым планом
P.am_apply_review = async function (extra = null) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (this.busy) return { ok: false, msg: this._t('am_busy') };
  if (!this._am_ctx) return { ok: false, msg: this._t('am_no_plan') };
  let dur = Number(this._am_ctx.dur || 0);
  const base = this._am_base_plan || { zoom: [], broll: [] };
  let src = (extra && typeof extra === 'object') ? extra : {};
  const base_cuts = base.cut || [];
  if (base_cuts.length) {
    src = Object.assign({}, src);
    for (const key of ['zoom', 'broll']) src[key] = (src[key] || []).filter(it => it.t != null).map(it => Object.assign({}, it, { t: Api._am_unmap_time(Number(it.t || 0), base_cuts) }));
    src.cut = (src.cut || []).map(c => Object.assign({}, c, { s: Api._am_unmap_time(Number(c.s || 0), base_cuts), e: Api._am_unmap_time(Number(c.e || 0), base_cuts) }));
    dur = Number((await AM.videoDur(vfs.read(BASE))) || dur);
  }
  const add = { cut: this._am_plan_cut(src.cut, dur), zoom: this._am_plan_zoom(src.zoom, dur), broll: this._am_plan_broll(src.broll, dur) };
  const merged = { cut: (base.cut || []).concat(add.cut).sort((a, b) => a.s - b.s), zoom: (base.zoom || []).concat(add.zoom).sort((a, b) => a.t - b.t), broll: (base.broll || []).concat(add.broll).sort((a, b) => a.t - b.t), bw: base.bw || [] };
  if (!(add.zoom.length || add.broll.length || add.cut.length)) {
    this._am_state = { state: 'done', file: (this._am_state || {}).file || '' };
    call_js('amProgress', this._am_state); call_js('amDone', this._am_state);
    log('  ▶ доп. правки отклонены — оставляю первую сборку');
    return { ok: true, skipped: true };
  }
  this.busy = true;
  this._am_state = { state: 'run', step: this._t('am_step_reassemble_extra') };
  log(`  ▶ приняты доп. правки: +${add.cut.length} вырезок, +${add.zoom.length} zoom, +${add.broll.length} вставок (итого ${merged.cut.length}/${merged.zoom.length}/${merged.broll.length})`);
  this._am_render(merged);
  return { ok: true };
};

// ---------- ФАЗА 2: применение эффектов + сохранение ----------
Api._am_map_time = function (t, cuts) { let off = 0; for (const c of cuts || []) { if (t >= c.e) off += c.e - c.s; else if (t > c.s) return null; } return Math.round((t - off) * 1000) / 1000; };
Api._am_unmap_time = function (t, cuts) { for (const c of [...(cuts || [])].sort((a, b) => a.s - b.s)) if (t >= c.s - 1e-6) t += c.e - c.s; return Math.round(t * 1000) / 1000; };
P._am_rebase_plan = function (plan, words, segs, cuts) {
  if (!cuts.length) return [plan, words, segs];
  let dropped = 0; const np = { strategy: (plan || {}).strategy, cut: [], zoom: [], broll: [], bw: (plan || {}).bw || [], lens: (plan || {}).lens || [] };
  for (const z of (plan || {}).zoom || []) { const t = Api._am_map_time(z.t, cuts); if (t === null) { dropped++; log(`  ↩ наезд @ ${z.t.toFixed(1)}с отменён — попал в вырезанный кусок`); continue; } np.zoom.push(Object.assign({}, z, { t })); }
  for (const b of (plan || {}).broll || []) { const t = Api._am_map_time(b.t, cuts); if (t === null) { dropped++; log(`  ↩ вставка @ ${b.t.toFixed(1)}с отменена — попала в вырезанный кусок`); continue; } np.broll.push(Object.assign({}, b, { t })); }
  const nw = [];
  for (const [w, s0, e0] of words || []) { const ns = Api._am_map_time(Number(s0), cuts), ne = Api._am_map_time(Number(e0), cuts); if (ns === null || ne === null || ne <= ns) continue; nw.push([w, ns, ne]); }
  const [ns] = nw.length ? am_segments(nw) : [[]];
  log(`  ⏱ тайминги пересчитаны: слов ${(words || []).length} → ${nw.length}, действий отменено ${dropped}`);
  return [np, nw, ns];
};
P._am_render = async function (plan) {
  try {
    const ctx = this._am_ctx || {}; const opts = Object.assign({}, ctx.opts || {});
    let words = ctx.words || [], segs = ctx.segs || [], word_times = ctx.word_times || [];
    this._am_used = this._am_used || new Set(); this._am_applied_broll = null;
    const baseBlob = vfs.read(BASE); const dur0 = (await AM.videoDur(baseBlob)) || Number(ctx.dur || 0);
    const cuts = ((plan || {}).cut || []).length && (opts.cuts ?? true) ? plan.cut : [];
    const orig_plan = plan;
    let keep = [[0, dur0]], seams = [];
    if (cuts.length) {
      this._am_step(this._t('am_step_cut_extra'));
      keep = []; let pos = 0;
      for (const c of cuts) { if (c.s > pos + 0.05) keep.push([pos, c.s]); pos = Math.max(pos, c.e); }
      if (dur0 > pos + 0.05) keep.push([pos, dur0]);
      if (!keep.length) keep = [[0, dur0]];
      let acc = 0; for (const [s0, e0] of keep.slice(0, -1)) { acc += e0 - s0; seams.push(Math.round(acc * 1000) / 1000); }
      const newdur = keep.reduce((a, [s, e]) => a + e - s, 0);
      log(`  ✂ вырезано ${cuts.length} кусок(ов), −${cuts.reduce((a, c) => a + c.e - c.s, 0).toFixed(1)}с: ${dur0.toFixed(1)}с → ${newdur.toFixed(1)}с` + (seams.length ? ` (стыков со смазом: ${seams.length} @ ${seams.map(j => j.toFixed(1) + 'с').join(', ')})` : ''));
      [plan, words, segs] = this._am_rebase_plan(plan, words, segs, cuts);
      word_times = words.length ? am_segments(words)[1] : [];
      this._am_ctx.dur = newdur;
    }
    const spec = { base: baseBlob, keep, seams, seamAmp: K('_AM_SEAM_AMP'), seamWide: K('_AM_SEAM_WIDE'), seamNarrow: K('_AM_SEAM_NARROW'), seamSigma: K('_AM_SEAM_SIGMA'), splitTop: SPLIT_TOP, splitBot: SPLIT_BOT, splitBorder: SPLIT_BORDER };
    const dur = Number(this._am_ctx.dur || dur0);
    // лупа за курсором
    if (opts.lens || ((plan || {}).lens || []).length) {
      this._am_step(this._t('am_step_find_cursor'));
      const track = await this._am_cursor_track(keep, dur);
      if (track.length) {
        let wins = (plan || {}).lens || [];
        if (!wins.length) wins = await this._am_lens_windows(track, dur, words);
        if (wins.length) {
          this._am_step(this._t('am_step_magnify_cursor'));
          const D = Math.trunc(K('_AM_LENS_D')); spec.lens = { track, wins, D, C: Math.max(40, Math.trunc(D / K('_AM_LENS_ZOOM'))) };
          log(`  🔍 лупа за курсором: ${track.length} точек трекинга, ×${K('_AM_LENS_ZOOM').toFixed(1)}`);
        }
      }
    }
    if (opts.broll && words.length) { this._am_step(this._t('am_step_find_broll')); const _lay = opts.broll_layout || 'auto'; spec.broll = await this._am_broll(words, segs, plan, ['full', 'split'].includes(_lay) ? _lay : 'split', ['full', 'split'].includes(_lay)); }
    if (opts.zoom && words.length) { this._am_step(this._t('am_step_zoompunch')); spec.zoom = this._am_zoom(words, plan); }
    if (opts.icons && segs.length) {
      this._am_step(this._t('am_step_platform_icons'));
      try { const hits = this._platform_icon_events(segs, word_times); if (Object.keys(hits).length) spec.icons = await this._overlay_platform_icons(hits); } catch (e) { log(`  ⚠ иконки: ${e.message || e}`); }
    }
    if (opts.bw_cam) { this._am_step(this._t('am_step_bw_camera')); spec.bw = await this._am_bw_cam((plan || {}).bw); }
    if (opts.emoji && words.length) { this._am_step(this._t('am_step_emoji')); spec.emoji = await this._am_emoji(words); }
    if (opts.subs && segs.length) { this._am_step(this._t('am_step_subs')); spec.ass = this._am_subs(segs, word_times, opts); }
    if (plan && (opts.sfx ?? true) && (opts.zoom || opts.broll)) {
      const _fact = this._am_applied_broll;
      const sfx_plan = { zoom: opts.zoom ? (plan.zoom || []) : [], broll: opts.broll ? (_fact !== null ? _fact : (plan.broll || [])) : [] };
      this._am_step(this._t('am_step_transitions')); spec.sfx = await this._am_add_sfx(sfx_plan);
    }
    this._am_step(this._t('am_step_save_gallery'));
    spec.onProgress = (f) => this._am_step(this._t('am_step_save_gallery') + ` ${Math.trunc(f * 100)}%`);
    const res = await AM.renderAutomontage(spec);
    const fn = `automontage_${strftime('%m%d_%H%M%S')}${res.ext}`; const out = 'output/' + fn;
    vfs.write(out, res.blob); await vfs.flush(out);
    this.last_reel = out;
    log(`✅ Автомонтаж готов: ${fn}`);
    this._ping_render();
    if (!this.licensed && this.trial_active) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); log('  🔒 триал израсходован (Автомонтаж) — доступ закрыт'); }
    if (plan && !this._am_reviewed) {
      this._am_reviewed = true; let extra = null;
      try { extra = await this._am_review(out, plan); } catch (e) { log(`  ⚠ второй проход: ${String(e.message || e).slice(0, 80)}`); }
      if (extra) { this._am_base_plan = orig_plan; this._am_state = { state: 'review', extra, file: fn }; call_js('amProgress', this._am_state); log('  ⏸ есть доп. предложения — жду решения пользователя'); return; }
    }
    this._am_state = { state: 'done', file: fn };
    call_js('amProgress', this._am_state); call_js('amDone', { file: fn });
  } catch (e) {
    log(`✖ Автомонтаж: ${e.message || e}`);
    this._am_state = { state: 'err', msg: String(e.message || e).slice(0, 160) };
    try { call_js('amProgress', this._am_state); } catch (e2) { }
  } finally { this.busy = false; }
};
// кадры УКОРОЧЕННОГО ролика: время выхода -> время базы
function keepMap(keep) { const cum = []; let a = 0; for (const [s, e] of keep) { cum.push(a); a += e - s; } return (t) => { for (let i = keep.length - 1; i >= 0; i--) if (t >= cum[i] - 1e-9) return Math.min(keep[i][1] - 0.001, keep[i][0] + (t - cum[i])); return 0; }; }

// ---------- наезды / наклоны ----------
P._am_motion_w = function (motion, amp) {
  const mo = ZOOM_MOTIONS.includes(motion) ? motion : 'ease'; const [base, scaled] = ZOOM_WIDTH[mo];
  const a = amp === null || amp === undefined ? ZOOM_AMP.soft : Math.abs(amp);
  return [mo, Math.max(0.04, scaled ? base * (a / ZOOM_AMP.soft) : base)];
};
P._am_zoom = function (words, plan = null) {
  let acc;
  if (plan) acc = (plan.zoom || []).map(z => [z.t, ZOOM_AMP[z.strength] ?? 0.12, z.motion || 'ease', z.kind || 'zoom']);
  else acc = words.filter(([w]) => is_important(w)).slice(0, 12).map(([w, s, e]) => [(Number(s) + Number(e)) / 2, 0.12, 'ease', 'zoom']);
  if (!acc.length) return null;
  const zooms = acc.filter(x => x[3] !== 'tilt'), tilts = acc.filter(x => x[3] === 'tilt');
  const Z = { zooms: [], tilts: [], comp: [], cap: 1 };
  for (const [t, a, m] of zooms) { const [mo, w] = this._am_motion_w(m, a); Z.zooms.push([t, a, mo, w]); }
  tilts.forEach(([t, a, m], i) => {
    const deg = a * TILT_DEG * (i % 2 === 0 ? 1 : -1); const rad = deg * Math.PI / 180; const [mo, w] = this._am_motion_w(m, a);
    Z.tilts.push([t, rad, mo, w]);
    Z.comp.push([t, Math.max(0, Math.abs(Math.cos(rad)) + (16 / 9) * Math.abs(Math.sin(rad)) - 1), mo, w]);
  });
  const caps = zooms.map(z => z[1]).concat(tilts.map(([, v]) => { const x = v * TILT_DEG * Math.PI / 180; return Math.abs(Math.cos(x)) + (16 / 9) * Math.abs(Math.sin(x)) - 1; }));
  Z.cap = 1 + (caps.length ? Math.max(...caps) : 0);
  if (tilts.length) log(`  ⤾ поворотов кадра: ${tilts.length} (наклон чередует сторону)`);
  return Z;
};
// ---------- эмодзи ----------
P._am_emoji = async function (words) {
  const by = new Map();
  for (const [w, s, e] of words) { const emo = am_emoji_for(w); if (emo) { if (!by.has(emo)) by.set(emo, []); by.get(emo).push([Math.max(0, Number(s) - 0.1), Number(e) + 1.0]); } }
  if (!by.size) return null;
  const out = [];
  for (const [emo, list] of by) {
    const c = new OffscreenCanvas(170, 170); const x = c.getContext('2d'); x.font = '132px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(emo, 85, 88);
    const img = await createImageBitmap(c);
    for (const [s, e] of list.slice(0, 8)) out.push({ img, s, e });
  }
  return out;
};
// ---------- субтитры ----------
P._am_subs = function (segs, word_times, opts) {
  try {
    const rs = Object.assign({}, C.STYLES[(parseInt(opts.style_idx || 0) || 0) % C.STYLES.length]);
    rs.size = Math.max(40, Math.trunc(1920 * this.sub_fontpct));
    const [al, mv] = this._sub_align_marginv(1920, rs.size);
    rs.outline = Math.max(8, rs.outline ?? 8); rs.shadow = Math.max(3, rs.shadow ?? 3); rs.align = al; rs.marginv = mv; rs.marginl = 90; rs.marginr = 90;
    return build_ass('temp/am_subs.ass', segs, rs, 1080, 1920, {}, null, null, 3, false, rs.anim ? word_times : null);
  } catch (e) { log(`  ⚠ субтитры не удались (${String(e.message || e).slice(0, 60)})`); return null; }
};
// ---------- ч/б «съёмка на камеру» ----------
P._am_bw_cam = async function (wins = null) {
  let frame = null, dot = null;
  try { frame = await createImageBitmap(await (await fetch(new URL('../assets/cam_frame.png', import.meta.url))).blob()); dot = await createImageBitmap(await (await fetch(new URL('../assets/cam_rec.png', import.meta.url))).blob()); }
  catch (e) { log('  ⚠ оверлеи камеры не найдены в сборке — пропускаю ч/б эффект'); return null; }
  const w = (wins || []).map(x => ({ t: Math.max(0, Number(x.t || 0)), dur: Math.max(0.5, Number(x.dur ?? K('_AM_BW_LEN'))) }));
  if (w.length) log('  ◐ ч/б «съёмка на камеру»: ' + w.map(x => `${x.t.toFixed(1)}–${(x.t + x.dur).toFixed(1)}с`).join(', '));
  return { wins: w.length ? w : null, frame, dot, vig: AM.vignetteCanvas() };
};
// ---------- иконки платформ ----------
P._platform_icon_events = function (segs, word_times) {
  if (!word_times || !word_times.length) return {};
  let subw = []; for (const s of segs) subw = subw.concat(clean_phrase(s.text).split(/\s+/).filter(Boolean));
  const n = Math.min(subw.length, word_times.length); const hits = {};
  for (let i = 0; i < n; i++) { const p = platform_of_word(subw[i]); if (p) (hits[p] = hits[p] || []).push([Math.max(0, Number(word_times[i][0]) - 0.1), Number(word_times[i][1]) + 1.1]); }
  for (const p of Object.keys(hits)) { const ivs = hits[p].sort((a, b) => a[0] - b[0]); const merged = [ivs[0]]; for (const [a, b] of ivs.slice(1)) { if (a <= merged[merged.length - 1][1] + 0.05) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b); else merged.push([a, b]); } hits[p] = merged; }
  return hits;
};
P._overlay_platform_icons = async function (hits) {
  const order = ['youtube', 'instagram', 'tiktok'].filter(p => hits[p]); if (!order.length) return null;
  const IW = 176, GAP = 34; const total = order.length * IW + (order.length - 1) * GAP; const x0 = Math.max(0, Math.trunc((1080 - total) / 2));
  const out = [];
  for (let j = 0; j < order.length; j++) {
    const p = order[j]; let img;
    try { img = await createImageBitmap(await (await fetch(new URL(`../assets/platform/${p}.png`, import.meta.url))).blob()); } catch (e) { log('  ⚠ иконки платформ не найдены в сборке — пропускаю оверлей'); return null; }
    for (const [s, e] of hits[p]) out.push({ img, x: x0 + j * (IW + GAP), s, e });
  }
  log(`  🎬 иконки платформ: ${order.join(', ')}`);
  return out;
};
// ---------- звуки переходов ----------
P._am_sfx_pool = function (kind) {
  try { const idx = (this._am_sfx_index || {})[C['Api._AM_SFX_DIR']] || []; return idx.filter(n => n.toLowerCase().startsWith(kind + '_') && n.toLowerCase().endsWith('.mp3')).sort().map(n => `assets/sfx/${C['Api._AM_SFX_DIR']}/${n}`); } catch (e) { return []; }
};
P._am_sfx_picker = function (kind) {
  const pool = this._am_sfx_pool(kind); if (!pool.length) return () => null;
  const deck = []; let last = null;
  return () => { if (!deck.length) { const fresh = shuffle([...pool]); if (fresh.length > 1 && last === fresh[fresh.length - 1]) [fresh[0], fresh[fresh.length - 1]] = [fresh[fresh.length - 1], fresh[0]]; deck.push(...fresh); } last = deck.pop(); return last; };
};
P._am_add_sfx = async function (plan) {
  try { const { sfxIndex } = await import('./api_misc.js'); this._am_sfx_index = await sfxIndex(); } catch (e) { this._am_sfx_index = {}; }
  const moments = ((plan || {}).zoom || []).map(z => ['zoom', z.t]).concat(((plan || {}).broll || []).map(b => ['broll', b.t])).sort((a, b) => a[1] - b[1]);
  if (!moments.length) return null;
  const pickers = { zoom: this._am_sfx_picker('zoom'), broll: this._am_sfx_picker('broll') };
  const VOL = K('_AM_SFX_VOL'), PRE = K('_AM_SFX_PREROLL'); const out = [], chosen = [];
  for (const [kind, t] of moments) {
    const p = pickers[kind] ? pickers[kind]() : null; if (!p) continue;
    let buf; try { buf = await A.decode(await (await fetch(new URL('../' + p, import.meta.url))).blob()); } catch (e) { continue; }
    const start = Math.max(0, t - (PRE[kind] || 0)); out.push({ buf, start, vol: VOL[kind] ?? 0.25 }); chosen.push([t, kind, path.basename(p), start]);
  }
  if (!out.length) { log('  ℹ звуки переходов: подходящих файлов не нашлось — без звука'); return null; }
  log(`  🔊 звуки переходов: ${out.length} шт. — ${new Set(chosen.map(c => c[2])).size} разных файлов из набора CC0`);
  for (const [t, kind, fn, start] of chosen) log(`      ♪ ${t.toFixed(1)}с ${kind.padEnd(6)} ${fn.padEnd(22)} (старт ${start.toFixed(2)}с)`);
  return out;
};

// ---------- b-roll ----------
P._am_broll = async function (words, segs, plan = null, layout = 'full', force_layout = false) {
  if (!segs.length) return null;
  let picks = [];
  if (plan) {
    for (const b of (plan.broll || [])) {
      const lay = force_layout ? layout : (b.layout || layout); let clip = b.clip;
      if (clip && b.clip_layout && b.clip_layout !== lay) { log(`  ♻ вставка @ ${Number(b.t).toFixed(1)}с: клип был скроен под «${b.clip_layout}», а нужен «${lay}» — готовлю заново`); clip = null; }
      picks.push([b.t, b.q, b.dur, b.why || 'по плану ИИ', clip, lay]);
    }
  } else {
    const cands = []; let last_t = -99;
    for (const sg of segs) { const txt = (sg.text || '').trim(); if (txt.split(/\s+/).length < 3) continue; const st = Number(sg.start || 0); if (st - last_t < 3.0) continue; cands.push([st, txt]); last_t = st; if (cands.length >= 12) break; }
    if (!cands.length) return null;
    const qmap = await this._am_broll_queries(cands.map(c => c[1]));
    picks = Object.entries(qmap).map(([i, q]) => [cands[i][0], q, 2.0, cands[i][1], null, layout]).sort((a, b) => a[0] - b[0]);
  }
  if (!picks.length) { log('  ℹ b-roll: релевантных визуальных моментов не найдено — без вставок'); return null; }
  const real = []; let last_e = -99;
  for (let [st, q, wdur, phrase, ready_clip, lay] of picks) {
    lay = ['full', 'split'].includes(lay) ? lay : 'full';
    if (st - last_e < 3.0) { log(`  ⚠ вставка @ ${Number(st).toFixed(1)}с пропущена: слишком близко к предыдущей (нужно ≥3с после её конца)`); continue; }
    const clip = (ready_clip && this._am_clips && this._am_clips[ready_clip]) ? this._am_clips[ready_clip] : await this._am_stock_clip(q, real.length, wdur, lay);
    if (clip) { real.push({ t: st, dur: wdur, layout: lay, clip: this._am_clips[clip] || clip }); last_e = st + wdur; log(`  🎬 b-roll @ ${Number(st).toFixed(1)}с ×${Number(wdur).toFixed(1)}с [${lay === 'split' ? 'раздельный' : 'полный кадр'}]: «${String(phrase).slice(0, 40)}» → "${q}"`); }
    if (real.length >= 6) break;
  }
  if (!real.length) return null;
  this._am_applied_broll = real.map(r => ({ t: r.t, dur: r.dur }));
  return real;
};
// ИИ-запросы по репликам: {idx: query}
P._am_broll_queries = async function (phrases) {
  if (!phrases.length) return {};
  const numbered = phrases.map((p, i) => `${i + 1}| ${p}`).join('\n');
  const prompt = 'Ты подбираешь СТОКОВОЕ видео/фото к репликам ролика. Ниже пронумерованные реплики.\nДля КАЖДОЙ дай КОРОТКИЙ поисковый запрос на АНГЛИЙСКОМ (2-3 слова), показывающий КОНКРЕТНЫЙ визуальный объект/действие/сцену ПО СМЫСЛУ реплики — что реально показать в кадре, а НЕ дословный перевод одного слова. Если в реплике нет ничего визуально-конкретного (только служебные/абстрактные слова: «поэтому», «именно», «уже», «который» и т.п.) — напиши NONE.\nОтвет СТРОГО по одной строке на реплику, формат: НОМЕР|запрос  ИЛИ  НОМЕР|NONE. Никаких пояснений.\n\n' + numbered;
  let ok, out; try { [ok, out] = await this._ai_call(prompt, null, 700); } catch (e) { ok = false; out = ''; }
  if (!ok || !out) return {};
  const res = {};
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s*[|):.\-]+\s*(.+?)\s*$/.exec(line); if (!m) continue;
    const idx = parseInt(m[1]) - 1; const q = m[2].trim().replace(/^["']+|["']+$/g, '').trim();
    if (!q || ['NONE', 'N/A', 'SKIP', '-'].includes(q.toUpperCase())) continue;
    if (!/[A-Za-z]/.test(q)) continue;
    res[idx] = q.slice(0, 60);
  }
  return res;
};
// сток по запросу -> клип вставки (файл + раскрой; рендер кадрирует под full 1080x1920 / split 1080x672)
P._am_stock_clip = async function (query, seed, want = 2.0, layout = 'full') {
  const _prev = this._reel_used_clips; this._reel_used_clips = this._am_used;
  let s = null, isv = null;
  try { [s, isv] = await this._download_pixabay(query, `am_${seed}`); } catch (e) { s = null; } finally { this._reel_used_clips = _prev; }
  if (!(s && vfs.exists(s))) return null;
  return this._am_clip_from_file(s, isv, seed, want, layout);
};
P._am_clip_from_file = function (s, isv, seed, want = 2.0, layout = 'full') {
  const id = `temp/am_broll_${seed}${isv ? '.mp4' : '.jpg'}`; vfs.copy(s, id);
  this._am_clips = this._am_clips || {};
  this._am_clips[id] = { kind: isv ? 'video' : 'image', blob: vfs.read(id), layout };
  return id;
};
// миниатюра вставки (кадр 0.5с, раскрой под полосу) 220px
P._am_clip_thumb = async function (clipId, layout, out) {
  const c = (this._am_clips || {})[clipId]; if (!c) return false;
  const [cw, ch] = layout === 'split' ? [1080, SPLIT_TOP] : [1080, 1920];
  let src, sw, sh;
  if (c.kind === 'image') { src = await createImageBitmap(c.blob); sw = src.width; sh = src.height; }
  else { const fr = await AM.sampleFrames(c.blob, [0.5], 360, 640); if (!fr[0]) return false; const cc = new OffscreenCanvas(360, 640); cc.getContext('2d').putImageData(new ImageData(fr[0], 360, 640), 0, 0); src = cc; sw = 360; sh = 640; }
  const tw = 220, th = Math.round(220 * ch / cw); const t = new OffscreenCanvas(tw, th); const x = t.getContext('2d');
  const sc = Math.max(tw / sw, th / sh); x.drawImage(src, (tw - sw * sc) / 2, (th - sh * sc) / 2, sw * sc, sh * sc);
  if (layout === 'split') { x.strokeStyle = 'rgba(255,255,255,0.92)'; x.lineWidth = Math.max(1, SPLIT_BORDER * tw / 1080); x.strokeRect(0, 0, tw, th); }
  vfs.write(out, await t.convertToBlob({ type: 'image/jpeg', quality: 0.85 })); await vfs.flush(out);
  return true;
};

// ---------- валидация плана ----------
Api._am_plan_window = function (dur) { return [0.5, Math.max(1.5, Number(dur) - 1.5)]; };
P._am_plan_broll = function (items, dur) {
  const [t0, t1] = Api._am_plan_window(dur); const cap = Math.max(2, Math.min(10, Math.trunc(dur / 8)));
  const out = []; let skipped = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    const t = Math.round(parseFloat(it.t) * 100) / 100; if (Number.isNaN(t)) continue;
    if (it.confidence != null && !Number.isNaN(parseFloat(it.confidence)) && parseFloat(it.confidence) < K('_AM_BROLL_MIN_CONF')) { skipped++; continue; }
    let q = String(it.q || '').trim().replace(/^["']+|["']+$/g, '');
    if (!q || !/[A-Za-z]/.test(q) || /[а-яёА-ЯЁ]/.test(q)) continue;
    if (q.split(/\s+/).length > 5) q = q.split(/\s+/).slice(0, 5).join(' ');
    let d = parseFloat(it.dur ?? 2.5); if (Number.isNaN(d)) d = 2.5; d = Math.max(1.5, Math.min(3.5, d));
    if (!(t0 <= t && t <= t1 - 0.5)) continue;
    if (out.some(b => Math.abs(t - b.t) < 5.0)) continue;
    const lay = String(it.layout || '').trim().toLowerCase();
    const item = { t, dur: Math.round(d * 100) / 100, q: q.slice(0, 60), src: String(it.src || '').slice(0, 80), what: String(it.what || '').slice(0, 40), why: String(it.why || '').slice(0, 60),
      layout: ['full', 'split'].includes(lay) ? lay : null, compare: String(it.compare || '').slice(0, 20) || null, manual: !!it.manual, review: !!it.review };
    if (it.confidence != null && !Number.isNaN(parseFloat(it.confidence))) item.conf = Math.round(parseFloat(it.confidence) * 100) / 100;
    for (const k of ['clip', 'thumb', 'clip_layout']) if (it[k]) item[k] = String(it[k]).slice(0, 300);
    out.push(item); if (out.length >= cap) break;
  }
  if (skipped) log(`  ℹ b-roll: ${skipped} момент(ов) пропущено — ИИ не уверен в теме (лучше без вставки)`);
  return out.sort((a, b) => a.t - b.t);
};
Api._am_stems = function (text) { return new Set((String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}_\-]+/gu) || []).filter(w => w.length > 2).map(w => w.slice(0, 5))); };
// заземление вставок на ДОСЛОВНУЮ цитату отрезка
P._am_ground_broll = function (items, segs) {
  if (!items || !Array.isArray(items) || !segs.length) return items;
  const segw = segs.map(s => [Number(s.start || 0), Number(s.end || 0), Api._am_stems(s.text)]);
  const out = []; let no_src = 0; const MATCH = K('_AM_SRC_MATCH');
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const t = parseFloat(it.t); if (Number.isNaN(t)) continue;
    const src = String(it.src || '').trim(); const stems = Api._am_stems(src);
    if (!stems.size) { no_src++; out.push(it); continue; }
    const hits = segw.map(([, , sw], i) => [i, [...stems].filter(x => sw.has(x)).length / stems.size]);
    const good = hits.filter(([, sc]) => sc >= MATCH);
    if (!good.length) { log(`  ↩ вставка @ ${t.toFixed(1)}с отброшена: слов «${src.slice(0, 40)}» нет в расшифровке (запрос «${String(it.q || '').slice(0, 30)}» взят из общего смысла, а не из речи)`); continue; }
    const here = segw.findIndex(([s0, e0]) => s0 - 0.2 <= t && t <= e0 + 0.2);
    const gmap = new Map(good);
    if (here >= 0 && (gmap.get(here) || 0) >= MATCH) { out.push(it); continue; }
    const ib = good.reduce((a, b) => { const ka = [Math.abs(segw[a[0]][0] - t), -a[1]], kb = [Math.abs(segw[b[0]][0] - t), -b[1]]; return (kb[0] < ka[0] || (kb[0] === ka[0] && kb[1] < ka[1])) ? b : a; })[0];
    const [s0, e0] = segw[ib]; const nt = Math.round(Math.min(Math.max(s0 + 0.1, s0), Math.max(s0 + 0.1, e0 - 0.3)) * 100) / 100;
    log(`  ⇄ вставка «${String(it.q || '').slice(0, 30)}» перенесена ${t.toFixed(1)}с → ${nt.toFixed(1)}с: слова «${src.slice(0, 40)}» звучат в отрезке ${s0.toFixed(1)}-${e0.toFixed(1)}с`);
    out.push(Object.assign({}, it, { t: nt }));
  }
  if (no_src) log(`  ℹ вставок без цитаты из речи: ${no_src} — проверить их по тексту нечем`);
  return out;
};
P._am_force_split = function (broll, pick = null) {
  if (!broll.length || broll.some(b => b.layout === 'split')) return;
  let tgt = null; const pt = parseFloat(pick);
  if (!Number.isNaN(pt)) tgt = broll.reduce((a, b) => Math.abs(Number(b.t || 0) - pt) < Math.abs(Number(a.t || 0) - pt) ? b : a);
  if (!tgt) tgt = broll.reduce((a, b) => Number(b.conf || 0) > Number(a.conf || 0) ? b : a);
  tgt.layout = 'split';
  log(`  ⇅ раздельный экран гарантирован: вставка @ ${Number(tgt.t || 0).toFixed(1)}с «${String(tgt.q || '').slice(0, 30)}» → split`);
};
Api._am_plan_strategy = function (s) {
  if (!s || typeof s !== 'object') return null;
  const _t = (k, n = 90) => s[k] ? String(s[k]).trim().slice(0, n) : '';
  const peaks = []; for (const p of (s.peaks || []).slice(0, 3)) { const v = parseFloat(p); if (!Number.isNaN(v)) peaks.push(Math.round(v * 10) / 10); }
  const out = { genre: _t('genre', 40), pace: _t('pace', 30), audience: _t('audience', 60), approach: _t('approach', 160), peaks };
  return (out.genre || out.approach) ? out : null;
};
P._am_plan_zoom = function (items, dur) {
  const [t0, t1] = Api._am_plan_window(dur); const cap = Math.max(3, Math.min(20, Math.trunc(dur / 4))); const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const t = Math.round(parseFloat(it.t) * 100) / 100; if (Number.isNaN(t)) continue;
    if (!(t0 <= t && t <= t1)) continue;
    let st = String(it.strength || 'medium').trim().toLowerCase(); if (!(st in ZOOM_AMP)) st = 'medium';
    let mo = String(it.motion || '').trim().toLowerCase(); if (!ZOOM_MOTIONS.includes(mo)) mo = 'ease';
    let kd = String(it.kind || '').trim().toLowerCase(); if (!['zoom', 'tilt'].includes(kd)) kd = 'zoom';
    if (out.some(z => Math.abs(t - z.t) < 3.0)) continue;
    out.push({ t, kind: kd, strength: st, motion: mo, why: String(it.why || '').slice(0, 60) });
    if (out.length >= cap) break;
  }
  return out.sort((a, b) => a.t - b.t);
};
P._am_plan_cut = function (items, dur) {
  const out = [], raw = [], thumbs = {}; let total = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    let s0 = parseFloat(it.s), e0 = parseFloat(it.e); if (Number.isNaN(s0) || Number.isNaN(e0)) continue;
    s0 = Math.max(0, Math.round(s0 * 100) / 100); e0 = Math.min(Number(dur), Math.round(e0 * 100) / 100);
    if (e0 - s0 < K('_AM_CUT_MIN')) continue;
    raw.push([s0, e0, String(it.why || '').slice(0, 40)]); if (it.thumb) thumbs[`${s0}|${e0}`] = String(it.thumb).slice(0, 300);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [s0, e0, why] of raw) {
    if (out.length && s0 < out[out.length - 1].e + 0.05) continue;
    if (total + (e0 - s0) > Number(dur) * K('_AM_CUT_MAX_SHARE')) { log(`  ℹ вырезки: остановился на ${Math.round(K('_AM_CUT_MAX_SHARE') * 100)}% хронометража — дальше резать опасно`); break; }
    const item = { s: s0, e: e0, why: why || 'лишний кусок' }; if (thumbs[`${s0}|${e0}`]) item.thumb = thumbs[`${s0}|${e0}`];
    out.push(item); total += e0 - s0;
  }
  return out;
};
P._am_plan_thumbs = async function (plan) {
  const items = plan.broll || []; if (!items.length) return;
  const layout = (this._am_opts || {}).broll_layout || 'full';
  this._am_step(this._t('am_step_pick_preview'));
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    try {
      const clip = await this._am_stock_clip(b.q, i, b.dur, layout); if (!clip) continue;
      b.clip = clip; b.clip_layout = layout;
      if (await this._am_clip_thumb(clip, layout, `temp/am_thumb_${i}.jpg`)) b.thumb = `temp/am_thumb_${i}.jpg?t=${Math.trunc(now())}`;
    } catch (e) { log(`  ⚠ превью вставки @ ${b.t}с: ${String(e.message || e).slice(0, 50)}`); }
  }
};
P._am_cut_thumbs = async function (plan) {
  const items = (plan || {}).cut || []; if (!items.length || !vfs.exists(BASE)) return;
  try {
    const frs = await AM.sampleFrames(vfs.read(BASE), items.map(c => c.s + 0.05), 220, 392);
    for (let i = 0; i < items.length; i++) {
      if (!frs[i]) continue; const cv = new OffscreenCanvas(220, 392); cv.getContext('2d').putImageData(new ImageData(frs[i], 220, 392), 0, 0);
      const f = `temp/am_cutthumb_${i}.jpg`; vfs.write(f, await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 })); await vfs.flush(f);
      items[i].thumb = `${f}?t=${Math.trunc(now())}`;
    }
  } catch (e) { }
};

// ---------- ИИ-план монтажа (один вызов Gemini) ----------
P._am_plan = async function (words, segs, dur, allow_cut = true, probe = null) {
  if (!segs.length || dur <= 0) return null;
  if (!this.gemini_key) { log('  ℹ план монтажа: нет ключа Gemini — механический режим (zoom/b-roll по словам)'); return null; }
  const lines = []; let total = 0;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i]; const _s = Number(sg.start || 0), _e = Number(sg.end || 0);
    const ln = `${i + 1}) [${_s.toFixed(1)}-${_e.toFixed(1)}, ${Math.max(0, _e - _s).toFixed(1)}с] ${(sg.text || '').trim()}`;
    total += ln.length; if (total > 12000) { log(`  ℹ план монтажа: расшифровка длинная — в ИИ ушли первые ${lines.length} фраз`); break; }
    lines.push(ln);
  }
  if (!lines.length) return null;
  const _nseg = Math.max(1, segs.length); const lo = Math.max(1, Math.round(_nseg * 0.6)), hi = Math.max(2, Math.round(_nseg * 0.7));
  const cut_rule = allow_cut ? '0) cut — ВЫРЕЗАТЬ кусок ролика целиком. Смотри на таймкоды: между фразами есть паузы, мысль повторяется дважды, тянется вода и слова-паразиты, темп провисает. s/e — начало и конец выреза в секундах, why — ПО-РУССКИ простыми словами («пауза», «повтор мысли», «затянуто», «слова-паразиты»). Режь ТОЛЬКО очевидно лишнее: смысл и связность речи обязаны сохраниться, фразу на середине не рвать. Один вырез ≥0.4с; если резать нечего — верни пустой список.\n' : '';
  const cut_ex = allow_cut ? '"cut":[{"s":8.0,"e":9.2,"why":"пауза"}],' : '';
  let prompt = `Ты — монтажёр коротких вертикальных видео. Ниже РАСШИФРОВКА ролика с реальными таймкодами речи. Длительность ролика: ${dur.toFixed(1)} сек.\n\n`
    + 'РАБОТАЙ В ДВА ШАГА. Сначала пойми, ЧТО это за ролик, и только потом решай, что с ним делать. Монтаж лайфхака и монтаж истории обязаны отличаться.\n\n'
    + 'ШАГ 1 — СТРАТЕГИЯ (поле strategy):\n• genre — жанр и цель: лайфхак/совет, история, продающий питч, юмор, обзор, разоблачение, мотивация…\n• pace — темп и энергия речи: спокойный / средний / напористый;\n• peaks — 1-3 кульминации: где эмоциональный или смысловой пик (в секундах);\n• audience — платформа и зритель: кому и куда это (TikTok-молодёжь, YouTube Shorts-профи, Reels-предприниматели…);\n• approach — 1-2 предложения: КАК монтировать именно такой ролик и почему.\n\n'
    + 'ШАГ 2 — ДЕЙСТВИЯ, ВЫТЕКАЮЩИЕ ИЗ СТРАТЕГИИ (а не сами по себе):\nПлотность и агрессивность зумов задай по темпу и жанру: напористый питч или юмор — чаще и жёстче (hard); спокойная история или обзор — реже и мягче (soft), акценты берегутся для кульминаций. Количество и характер вставок — по тому, есть ли что показывать: у лайфхака и обзора предметные вставки уместны часто, у личной истории они разрушают контакт с говорящим — там их почти не должно быть.\n'
    + '1) zoom — короткий наезд в момент СМЫСЛОВОГО удара: заявление, цифра/факт, поворот мысли, вывод, обещание. НЕ на каждое длинное слово и НЕ подряд.\n   • kind — ТИП движения камеры:\n       "zoom" — наезд/приближение (базовый акцент);\n       "tilt" — лёгкий поворот кадра (наклон): берёт другой канал восприятия, уместен там, где наезд уже приелся, где речь про сбой, слом, «мир перевернулся», а также в юморе и треш-подаче. Не ставь tilt подряд и не делай его основным — это приправа, наездов всё равно должно быть больше.\n   • motion — ХАРАКТЕР движения, не только сила:\n       "crash" — резкий рывок, камера бьёт мгновенно: шок, разоблачение, удар по больному, кульминация;\n       "ease" — плавный разгон и торможение: спокойная мысль, вывод, лирика, объяснение;\n       "linear" — ровное механическое движение без ускорений: перечисление, инструкция, нейтральный факт.\n'
    + cut_rule
    + '2) broll — сток-вставка там, где в речи назван КОНКРЕТНЫЙ визуальный объект/действие/место. q — запрос на АНГЛИЙСКОМ (2-3 слова): что реально видно в кадре, а не дословный перевод слова.\n   • ГЛАВНОЕ ПРАВИЛО ВСТАВКИ: картинка обязана показывать то, что сказано ИМЕННО В ЭТОМ ОТРЕЗКЕ, а НЕ общий смысл ролика. Если в отрезке речь про блокировку аккаунта — на вставке блокировка/запрет, а не «потерянные деньги», даже если ролик в целом про заработок. Мимо-кадр по общей теме зритель читает как ошибку монтажа.\n   • seg — НОМЕР отрезка из расшифровки, к которому относится вставка (число из списка ниже). t обязан лежать ВНУТРИ этого отрезка.\n   • src — ДОСЛОВНАЯ ЦИТАТА из этого отрезка (2-5 слов, копируй из расшифровки без изменений), которая и называет показанный объект. Сначала найди цитату, и только потом строй q ПО ЦИТАТЕ. Если процитировать нечего — значит, показывать тут нечего: вставку не добавляй.\n   • what — ПО-РУССКИ 2-4 слова: что зритель увидит на вставке («руки на ноутбуке», «ночной город сверху»). Это описание показывается пользователю.\n   • confidence — 0.0-1.0, насколько ты УВЕРЕН, что сток по этому запросу ляжет в тему. Если уверенность НИЖЕ 0.6 — НЕ добавляй этот момент вообще. Пустое место лучше отдалённо похожей картинки: зритель замечает мимо-кадр мгновенно.\n   • layout — как показать вставку, решай ПОКАДРОВО:\n       "split" — раздельный экран (сверху сток, снизу продолжается оригинал), когда ВАЖНО не терять говорящего: он жестикулирует, показывает что-то руками, держит предмет, реагирует лицом, либо это эмоциональный/личный момент;\n       "full" — полноэкранная замена, когда картинка оригинала в этот момент не несёт информации (статичная голова, общий план) и вставка может занять весь кадр.\n   • РАЗНООБРАЗИЕ МАКЕТОВ: если вставок хотя бы одна, ХОТЯ БЫ ОДНА из них обязана быть "split". Реши по своим же критериям, какая подходит лучше всего (там, где важнее не терять говорящего), и поставь ей split — даже если по каждой отдельно ты склонялся к full. Один макет на весь ролик выглядит однообразно.\n   • split_pick — момент t той вставки, которую ты выбрал под split (число). Если split уже стоит — просто повтори его t.\n'
    + 'ЗЕРНИСТОСТЬ РЕШЕНИЙ: расшифровка ниже разбита на пронумерованные ОТРЕЗКИ по границам фраз (примерно 3-5с). Иди ПО КАЖДОМУ отрезку отдельно и решай, нужен ли эффект именно здесь. Не оценивай речь широкими кусками — от этого монтаж выходит рыхлым и одинаковым.\n'
    + 'ПЛОТНОСТЬ. Порядок работы такой: пройди по отрезкам ПО ОЧЕРЕДИ и для каждого реши «эффект нужен» или «оставляю голым». Ориентир — «нужен» примерно на 60-70% отрезков; остальные 30-40% оставляй НАМЕРЕННО ГОЛЫМИ, особенно там, где звучит важная мысль: её нужно услышать, а не разглядывать движение.\n'
    + `В этом ролике ${dur.toFixed(0)}с и ${_nseg} отрезков — это примерно ${lo}-${hi} эффектов ВСЕГО (zoom и broll вместе). Прежде чем ответить, ПОСЧИТАЙ свои действия: если их заметно меньше нижней границы — вернись и добавь на тех отрезках, где эффект уместен, но ты его не поставил. Слишком редкий монтаж читается как «сырой, необработанный материал». Жанр корректирует ориентир: спокойной истории ближе к нижней границе, напористому питчу — к верхней.\n`
    + 'zoom и broll МОГУТ стоять в одном отрезке ОДНОВРЕМЕННО, если это оправдано (наезд усиливает момент, а вставка иллюстрирует названный объект) — они НЕ взаимоисключающие. Но не делай так подряд везде: только там, где уместны оба.\n'
    + 'ПРИ СОМНЕНИИ — МЕНЬШЕ. Избыточный монтаж (эффекты подряд, стек ради стека) снижает удержание СИЛЬНЕЕ, чем недостаточный: зритель устаёт и уходит. Если не уверен, что эффект здесь нужен, — не ставь его.\n'
    + 'ПЕРВЫЕ 2-3 СЕКУНДЫ — ПРИОРИТЕТНАЯ ЗОНА, важнее любого места в середине: там решается, останется зритель или уйдёт. Начни с отрезка №1 и спроси себя: есть ли в первых 3 секундах за что зацепиться — сильная фраза, шок, обещание, цифра, интрига? Если да — ПЕРВЫЙ эффект ставь не позже 3.0с (обычно это crash-наезд на ударном слове). Правило «при сомнении меньше» на эту зону НЕ распространяется: здесь лучше поставить акцент, чем пропустить. Не ставь его, только если начало действительно пустое (вдох, служебные слова, обрывок фразы) — тогда этот кусок скорее кандидат в cut.\n'
    + 'Правила: между соседними zoom ≥3с; между соседними broll ≥5с; не раньше 0.5с и не в последние 1.5с ролика; таймкоды — секунды с одной десятичной, строго внутри ролика.\nstrength: soft|medium|hard — по силе смысла. dur: длительность вставки 1.5-3.5с.\nwhy: 3-6 слов, почему здесь (пойдёт в лог и пользователю).\nОтветь ТОЛЬКО валидным JSON, без markdown и пояснений:\n'
    + '{"strategy":{"genre":"лайфхак","pace":"напористый","peaks":[12.4],"audience":"TikTok, начинающие блогеры","approach":"частые жёсткие акценты, предметные вставки на каждом шаге инструкции"},'
    + cut_ex
    + '"zoom":[{"t":12.4,"kind":"zoom","strength":"medium","motion":"crash","why":"цифра в аргументе"},{"t":31.0,"kind":"tilt","strength":"soft","motion":"ease","why":"слом привычного порядка"}],"broll":[{"t":20.1,"seg":7,"src":"выходишь в ночной город","dur":2.5,"q":"night city traffic","what":"ночной трафик","confidence":0.8,"layout":"full","why":"назван ночной город"}],"split_pick":20.1}'
    + '\n\nРАСШИФРОВКА:\n' + lines.join('\n');
  if (probe) prompt += `\n\nРЕЖИМ «РЕШАЙ САМ». Пользователь ничего не настраивал — эффекты выбираешь ТЫ по содержанию. Подсказка по картинке (НЕ приговор, проверь по речи): тип=${probe.kind || 'other'}, плоскость кадра=${Number(probe.flat || 0).toFixed(2)}, лицо в кадре=${(Number(probe.face || 0) * 100).toFixed(0)}% времени.\n1) ЭКРАН. Если это запись экрана (человек показывает интерфейс и рассказывает) — добавь "lens":true. Мелкий текст интерфейса иначе нечитаем в вертикальном кадре. Если это НЕ запись экрана — "lens":false.\n2) ЧЕЛОВЕК ГОВОРИТ ИНТЕРЕСНОЕ. Найди ОДИН самый цепляющий смысловой момент (не любой говорящий кадр подряд, а именно значимый: вывод, признание, поворот мысли) и поставь "bw":[{"t":СЕК,"dur":4.5,"why":"..."}] — ч/б «съёмка на камеру» на 4-5с. Момент должен быть там, где человек в кадре. Не нашёл по-настоящему сильного места — верни "bw":[].\n3) СРАВНЕНИЕ. Если контент что-то с чем-то СОПОСТАВЛЯЕТ (до/после, было/стало, старое/новое, дёшево/дорого) — сделай на этом месте вставку с "layout":"split". В раздельном экране СВЕРХУ идёт твоя вставка, а СНИЗУ остаётся исходное видео. Поэтому "q" такой вставки обязан показывать НОВОЕ/РЕЗУЛЬТАТ (то, к чему пришли), а НЕ старое: старое зритель и так видит снизу в оригинале. Пометь такую вставку "compare":"new_on_top" и объясни в "why", что с чем сравнивается. Сравнения в ролике нет — обычные вставки, ничего не выдумывай.`;
  let ok, out; try { [ok, out] = await this._ai_call(prompt, null, 1500, null, 'gemini'); } catch (e) { ok = false; out = String(e.message || e); }
  if (!ok || !out) { log(`  ⚠ план монтажа: ИИ недоступен (${String(out).slice(0, 60)}) — механический режим`); return null; }
  let data;
  try { const mt = /\{[\s\S]*\}/.exec(out); data = JSON.parse(mt ? mt[0] : out); } catch (e) { log(`  ⚠ план монтажа: ответ ИИ не разобран (${String(e.message || e).slice(0, 50)}) — механический режим`); return null; }
  const plan = { cut: allow_cut ? this._am_plan_cut(data.cut, dur) : [], zoom: this._am_plan_zoom(data.zoom, dur), broll: this._am_plan_broll(this._am_ground_broll(data.broll, segs), dur), strategy: Api._am_plan_strategy(data.strategy) };
  if (probe) {
    plan.bw = this._am_plan_bw(data.bw, dur); plan.ai_lens = !!data.lens;
    const _cmp = plan.broll.filter(b => b.compare); if (_cmp.length) { for (const b of _cmp) b.layout = 'split'; log(`  ⚖ сравнение «до/после»: ${_cmp.length} вставк(и) split, новое сверху`); }
  }
  this._am_force_split(plan.broll, data.split_pick);
  const _rz = (data.zoom || []).length, _rb = (data.broll || []).length;
  if (_rz !== plan.zoom.length || _rb !== plan.broll.length) log(`  ℹ проверка плана: zoom ${_rz}→${plan.zoom.length}, вставок ${_rb}→${plan.broll.length} (отсеяны интервалы/повторы)`);
  log(`  📊 плотность: ${plan.zoom.length + plan.broll.length} эффект(ов) на ${Math.max(1, segs.length)} отрезков ≈ ${Math.round((plan.zoom.length + plan.broll.length) / Math.max(1, segs.length) * 100)}% (ориентир 60-70%)`);
  if (!(plan.zoom.length || plan.broll.length || plan.cut.length)) { log('  ⚠ план монтажа: ИИ не предложил ни одного момента — механический режим'); return null; }
  await this._am_plan_thumbs(plan); await this._am_cut_thumbs(plan);
  log(`  🧠 ПЛАН МОНТАЖА (Gemini): вырезок ${plan.cut.length}, zoom ${plan.zoom.length}, b-roll ${plan.broll.length} — на ${dur.toFixed(0)}с`);
  for (const c of plan.cut) log(`      ✂ вырезать ${c.s.toFixed(1)}-${c.e.toFixed(1)}с (−${(c.e - c.s).toFixed(1)}с) — ${c.why}`);
  for (const z of plan.zoom) log(`      ⤢ zoom @ ${z.t.toFixed(1)}с [${z.strength}] — ${z.why}`);
  for (const b of plan.broll) log(`      🎬 b-roll @ ${b.t.toFixed(1)}с ×${b.dur.toFixed(1)}с → "${b.q}" — ${b.why}`);
  return plan;
};
// «что это за видео»: плоскость/насыщенность 8 кадров + доля лица -> подсказка ИИ
P._am_probe_content = async function (base, dur) {
  const res = { kind: 'other', flat: 0.0, sat: 0.0, face: 0.0 };
  const n = 8; const times = [...Array(n).keys()].map(i => (i + 0.5) * Math.max(1, dur) / n);
  let frs; try { frs = await AM.sampleFrames(vfs.read(base), times, 320, 568); } catch (e) { return res; }
  const flats = [], sats = [];
  for (const d of frs) {
    if (!d) continue; let ss = 0, fl = 0, cnt = 0; const w = 320, h = 568;
    for (let i = 0; i < d.length; i += 4) ss += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) { const i = (y * w + x) * 4; const g1 = (d[i] + d[i + 1] + d[i + 2]) / 3, g2 = (d[i + 4] + d[i + 5] + d[i + 6]) / 3; if (Math.abs(g2 - g1) < 3) fl++; cnt++; }
    sats.push(ss / (w * h)); flats.push(fl / cnt);
  }
  if (!flats.length) return res;
  res.flat = flats.reduce((a, b) => a + b, 0) / flats.length; res.sat = sats.reduce((a, b) => a + b, 0) / sats.length;
  const faces = await this._am_face_scan(base, dur);
  if (faces.length) res.face = faces.filter(([, a]) => a > 0.005).length / faces.length;
  if (res.flat > 0.80 && res.sat < 45) res.kind = 'screencast'; else if (res.face >= 0.3) res.kind = 'talking';
  log(`  🔎 разбор картинки: плоскость ${res.flat.toFixed(2)}, насыщенность ${res.sat.toFixed(0)}, лицо ${(res.face * 100).toFixed(0)}% → ${res.kind}`);
  return res;
};
// ---------- лица (ultraface) ----------
Api._am_nms = function (boxes, scores, iou = 0.4) {
  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]); const keep = [];
  for (const i of order) {
    const b = boxes[i]; let good = true;
    for (const k of keep) { const a = boxes[k]; const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]); const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter; if (ua > 0 && inter / ua > iou) { good = false; break; } }
    if (good) keep.push(i);
  }
  return keep.map(i => boxes[i]);
};
P._am_face_scan = async function (base, dur) {
  if (this._am_face_cache && this._am_face_cache.dur === dur) return this._am_face_cache.out;
  const sess = await AM.faceSession(new URL('../assets/' + K('_AM_FACE_MODEL'), import.meta.url).href);
  if (!sess) { log('  ℹ детектор лиц недоступен — ч/б встанет по речи'); return []; }
  if (dur <= 1.0) return [];
  const FPSF = K('_AM_FACE_FPS'); const times = []; for (let t = 0; t < dur; t += 1 / FPSF) times.push(t);
  const t0 = now(); const frs = await AM.sampleFrames(vfs.read(base), times, 320, 240); const out = [];
  for (let i = 0; i < frs.length; i++) {
    try {
      if (!frs[i]) { out.push([times[i], 0]); continue; }
      const dets = (await AM.faceRun(sess, frs[i])).filter(d => d.score > K('_AM_FACE_THR'));
      let area = 0; for (const b of Api._am_nms(dets.map(d => d.box), dets.map(d => d.score))) area += Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      out.push([times[i], Math.min(1, area)]);
    } catch (e) { out.push([times[i], 0]); }
  }
  const seen = out.filter(([, a]) => a > 0.005).length;
  log(`  🙂 детекция лиц: ${out.length} кадров за ${(now() - t0).toFixed(1)}с, лицо на ${seen} (${Math.round(seen / Math.max(1, out.length) * 100)}%)`);
  this._am_face_cache = { dur, out };
  return out;
};
P._am_pick_bw_window = function (dur, faces, plan, words) {
  const ln = K('_AM_BW_LEN'); if (dur <= ln + 1.5) return null;
  const busy = ((plan || {}).broll || []).map(b => [Number(b.t || 0), Number(b.t || 0) + Number(b.dur || 2)]).concat(((plan || {}).cut || []).map(c => [Number(c.s || 0), Number(c.e || 0)]));
  let best = null, best_sc = -1; const by_face = faces.some(([, a]) => a > 0.005);
  for (let t = 0.5; t + ln <= dur - 0.5; t += 0.5) {
    const s0 = t, e0 = t + ln;
    if (busy.some(([bs, be]) => s0 < be && bs < e0)) continue;
    const sc = by_face ? faces.filter(([ft]) => s0 <= ft && ft < e0).reduce((a, [, ar]) => a + ar, 0) : (words || []).filter(([, ws]) => s0 <= Number(ws) && Number(ws) < e0).length;
    if (sc > best_sc) { best_sc = sc; best = s0; }
  }
  if (best === null || best_sc <= 0) return null;
  return { t: Math.round(best * 100) / 100, dur: ln, why: by_face ? 'в кадре лицо — «съёмка на камеру» читается' : 'самая плотная речь — говорящий в кадре' };
};
// ---------- курсор и лупа ----------
P._am_cursor_track = async function (keep, dur) {
  const SW = 270, SH = 480; const FPSL = K('_AM_LENS_FPS'); const map = keepMap(keep);
  const times = []; for (let t = 0; t < dur; t += 1 / FPSL) times.push(map(t));
  let frs; try { frs = await AM.sampleFrames(vfs.read(BASE), times, SW, SH, true); } catch (e) { log(`  ℹ кадры для трекинга курсора не сняты (${String(e.message || e).slice(0, 50)})`); return []; }
  this._am_cur_frames = frs;
  const pts = []; let prev = null;
  frs.forEach((g, i) => {
    const t = i / FPSL;
    if (!g) { prev = null; return; }
    if (prev) {
      let n = 0; const m = new Uint8Array(g.length); for (let j = 0; j < g.length; j++) if (Math.abs(g[j] - prev[j]) > 18) { m[j] = 1; n++; }
      if (n >= 3 && n <= 0.02 * SW * SH) {
        let n2 = 0; for (let j = 0; j < g.length; j++) if (m[j] && g[j] < 110) n2++;
        const use = n2 >= 3 ? ((j) => m[j] && g[j] < 110) : ((j) => m[j]);
        const xs = [], ys = []; for (let j = 0; j < g.length; j++) if (use(j)) { xs.push(j % SW); ys.push(Math.floor(j / SW)); }
        const med = (a) => { a.sort((p, q) => p - q); const h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };
        pts.push([t, med(xs) / SW, med(ys) / SH]);
      } else pts.push([t, null, null]);
    }
    prev = g;
  });
  if (!pts.length) return [];
  const good = pts.filter(p => p[1] !== null).length; const conf = good / Math.max(1, pts.length);
  log(`  🔍 трекинг курсора: ${pts.length} кадров, надёжных ${good} (${Math.round(conf * 100)}%)`);
  if (conf < K('_AM_LENS_MIN_CONF')) { log('  ℹ курсор уверенно не прослеживается — лупу не ставим'); return []; }
  return Api._am_track_fill(pts, dur);
};
Api._am_track_fill = function (pts, dur) {
  const idx = pts.map((p, i) => p[1] !== null ? i : -1).filter(i => i >= 0); if (!idx.length) return [];
  const out = [];
  pts.forEach(([t, x, y], i) => {
    if (x === null) {
      const lo = idx.filter(j => j < i).pop(), hi = idx.find(j => j > i);
      if (lo === undefined && hi === undefined) return;
      if (lo === undefined) [x, y] = [pts[hi][1], pts[hi][2]]; else if (hi === undefined) [x, y] = [pts[lo][1], pts[lo][2]];
      else { const k = (i - lo) / (hi - lo); x = pts[lo][1] + (pts[hi][1] - pts[lo][1]) * k; y = pts[lo][2] + (pts[hi][2] - pts[lo][2]) * k; }
    }
    out.push([t, x, y]);
  });
  const a = 0.45; const sm = out.map(p => [...p]);
  for (let i = 1; i < sm.length; i++) { sm[i][1] = a * sm[i][1] + (1 - a) * sm[i - 1][1]; sm[i][2] = a * sm[i][2] + (1 - a) * sm[i - 1][2]; }
  const lead = 1.1; const res = [];
  sm.forEach(([t, x, y], i) => { if (i) { x += (sm[i][1] - sm[i - 1][1]) * lead; y += (sm[i][2] - sm[i - 1][2]) * lead; } res.push([Math.round(t * 1000) / 1000, Math.round(Math.max(0, Math.min(1, x)) * 1080), Math.round(Math.max(0, Math.min(1, y)) * 1920)]); });
  return res.filter(p => dur <= 0 || p[0] <= dur);
};
P._am_lens_windows = async function (track, dur, words) {
  if (!track.length || dur <= 0) return [];
  const fps = K('_AM_LENS_FPS'); const spoken = (words || []).map(w => [Number(w[1]), Number(w[2])]);
  const talking = (t0, t1) => spoken.length ? spoken.some(([ws, we]) => ws < t1 && t0 < we) : true;
  const SW = 270, SH = 480; const frs = this._am_cur_frames || []; const cand = []; let prev = null;
  track.forEach(([t, x, y], idx) => {
    let slow = false; if (prev) { const dx = x - prev[0], dy = y - prev[1]; slow = Math.hypot(dx, dy) < K('_AM_LENS_SLOW_PX'); }
    prev = [x, y];
    if (!slow || !talking(t, t + 1 / fps)) return;
    const g = frs[idx + 1]; if (!g) return;
    const cx = Math.trunc(x * SW / 1080), cy = Math.trunc(y * SH / 1920), r = 34;
    const x0 = Math.max(0, cx - r), x1 = Math.min(SW, cx + r), y0 = Math.max(0, cy - r), y1 = Math.min(SH, cy + r);
    if ((x1 - x0) * (y1 - y0) < 400) return;
    let n = 0, tot = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1 - 1; xx++) { if (Math.abs(g[yy * SW + xx + 1] - g[yy * SW + xx]) > 28) n++; tot++; }
    cand.push([t, n / tot]);
  });
  if (!cand.length) { log('  ℹ лупа: курсор нигде не задерживался под речь — эффект не ставим'); return []; }
  const vals = cand.map(c => c[1]).sort((a, b) => a - b); const q = vals[Math.min(vals.length - 1, Math.trunc(vals.length * K('_AM_LENS_DETAIL_Q')))];
  const thr = Math.max(K('_AM_LENS_DETAIL_FLOOR'), q); const good = cand.filter(([, v]) => v >= thr).map(c => c[0]);
  log(`  🔎 лупа: кандидатов ${cand.length}, порог детализации ${thr.toFixed(3)} (квартиль ${q.toFixed(3)})`);
  if (!good.length) { log('  ℹ лупа: моментов «мелко и важно» не нашлось — эффект не ставим'); return []; }
  const WMIN = K('_AM_LENS_WIN_MIN'), WMAX = K('_AM_LENS_WIN_MAX'); const wins = []; let s0 = good[0], prevt = good[0];
  for (const t of good.slice(1).concat([1e9])) {
    if (t - prevt <= 0.9) { prevt = t; continue; }
    let ln = Math.max(prevt - s0, WMIN); ln = Math.min(ln, WMAX, Math.max(0, dur - s0));
    if (ln >= WMIN * 0.9) wins.push({ t: Math.round(s0 * 100) / 100, dur: Math.round(ln * 100) / 100, why: 'курсор задержался на мелком' });
    if (t > 1e8) break; s0 = prevt = t;
  }
  const merged = [];
  for (const w of wins) { const L = merged[merged.length - 1]; if (L && w.t - (L.t + L.dur) < 0.6) { const end = Math.min(w.t + w.dur, L.t + WMAX); L.dur = Math.round(Math.max(L.dur, end - L.t) * 100) / 100; } else merged.push(w); }
  const res = merged.slice(0, 6);
  if (res.length) log(`  🔍 лупа по смыслу: ${res.length} окон — ` + res.map(w => `${w.t.toFixed(1)}–${(w.t + w.dur).toFixed(1)}с`).join(', '));
  else log('  ℹ лупа: задержки курсора слишком короткие — эффект не ставим');
  return res;
};

// ---------- второй проход (vision по кадрам собранного ролика) ----------
P._am_review = async function (out_path, plan) {
  if (!(out_path && vfs.exists(out_path)) || !this.gemini_key) return null;
  const dur = (await AM.videoDur(vfs.read(out_path))) || 0; if (dur < 6) return null;
  this._am_step(this._t('am_step_review_ai'));
  const n = dur < 45 ? 6 : 8; const times = [...Array(n).keys()].map(i => Math.round(dur * (i + 0.5) / n * 100) / 100);
  const shots = [];
  const frs = await AM.sampleFrames(vfs.read(out_path), times, 384, 683);
  for (let i = 0; i < times.length; i++) {
    if (!frs[i]) continue; const cv = new OffscreenCanvas(384, 683); cv.getContext('2d').putImageData(new ImageData(frs[i], 384, 683), 0, 0);
    const f = `temp/am_rev_${i}.jpg`; vfs.write(f, await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 })); shots.push([times[i], f]);
  }
  if (shots.length < 3) { log('  ⚠ второй проход: не удалось взять кадры — пропускаю'); return null; }
  const applied = ((plan || {}).zoom || []).map(z => `zoom @ ${z.t.toFixed(1)}с`).concat(((plan || {}).broll || []).map(b => `вставка «${b.q}» @ ${b.t.toFixed(1)}с`));
  const prompt = `Ты — монтажёр коротких вертикальных видео. Ролик УЖЕ СОБРАН. Ниже кадры из него по порядку, снятые в моменты: ${shots.map(s => s[0].toFixed(1)).join(', ')} (секунды). Длительность ролика ${dur.toFixed(1)} сек.\n\nУже применено: ${applied.length ? applied.join('; ') : 'ничего'}\n\n`
    + 'Посмотри на КАДРЫ и скажи, чего не хватает для удержания внимания. Ищи именно то, что видно ГЛАЗАМИ, а не по тексту: длинный статичный кусок без событий, «говорящая голова» без иллюстрации, пустой или скучный кадр, момент, где взгляд провисает.\nПредложи ТОЛЬКО ДОПОЛНИТЕЛЬНЫЕ моменты (то, что уже применено, НЕ повторяй):\n1) zoom — короткий наезд там, где картинка стоит на месте и нужен акцент;\n2) broll — полноэкранная вставка там, где кадр не иллюстрирует сказанное. q — поисковый запрос на АНГЛИЙСКОМ (2-3 слова), что показать.\nБудь сдержан: 1-4 правки на весь ролик. Если всё и так плотно — верни пустые списки. Мусорные правки хуже их отсутствия.\nПравила: между новым и уже применённым моментом ≥3с; ничего в первую 1с и последние 1.5с; таймкоды внутри ролика.\nwhy — 3-6 слов: ЧТО ИМЕННО не так в кадре (для лога и для пользователя).\nОтветь ТОЛЬКО валидным JSON без markdown:\n'
    + '{"zoom":[{"t":12.4,"strength":"medium","why":"статичный кадр без акцента"}],"broll":[{"t":20.1,"dur":2.5,"q":"city traffic night","why":"кадр не иллюстрирует речь"}]}';
  let ok, out; try { [ok, out] = await this._ai_call(prompt, null, 1200, null, 'gemini', shots.map(s => s[1])); } catch (e) { ok = false; out = String(e.message || e); }
  if (!ok || !out) { log(`  ⚠ второй проход: ИИ недоступен (${String(out).slice(0, 60)})`); return null; }
  let data; try { const mt = /\{[\s\S]*\}/.exec(out); data = JSON.parse(mt ? mt[0] : out); } catch (e) { log(`  ⚠ второй проход: ответ не разобран (${String(e.message || e).slice(0, 50)})`); return null; }
  const extra = { zoom: this._am_plan_zoom(data.zoom, dur), broll: this._am_plan_broll(data.broll, dur) };
  const zs = ((plan || {}).zoom || []).map(z => [z.t, z.t]), bs = ((plan || {}).broll || []).map(b => [b.t, b.t + (b.dur || 2.5)]);
  const free = (t0, t1, spans, gap) => spans.every(([s, e]) => t0 >= e + gap || t1 <= s - gap);
  extra.zoom = extra.zoom.filter(z => free(z.t, z.t, zs, 3.0)); extra.broll = extra.broll.filter(b => free(b.t, b.t + (b.dur || 2.5), bs, 3.0));
  if (!(extra.zoom.length || extra.broll.length)) { log('  ✓ второй проход: ИИ считает, что добавлять нечего'); return null; }
  await this._am_plan_thumbs(extra);
  log(`  🔎 ВТОРОЙ ПРОХОД (Gemini vision по ${shots.length} кадрам): +${extra.zoom.length} zoom, +${extra.broll.length} вставок`);
  for (const z of extra.zoom) log(`      ⤢ +zoom @ ${z.t.toFixed(1)}с [${z.strength}] — ${z.why}`);
  for (const b of extra.broll) log(`      🎬 +b-roll @ ${b.t.toFixed(1)}с → "${b.q}" — ${b.why}`);
  return extra;
};

// ---------- UI плана: кадры сцен, подсказки запросов, галерея вставок ----------
P.am_scene_frames = async function () {
  try {
    const segs = (this._am_ctx || {}).segs || []; if (!(vfs.exists(BASE) && segs.length)) return { ok: false };
    for (const f of vfs.list('temp/' + K('_AM_STRIP_PREFIX'))) vfs.remove(f);
    const list = segs.slice(0, K('_AM_SCENES_MAX')); const mids = list.map(s => Math.max(0, (Number(s.start || 0) + Number(s.end || 0)) / 2));
    const frs = await AM.sampleFrames(vfs.read(BASE), mids, 132, 235); const stamp = Math.trunc(now()); const out = [];
    for (let i = 0; i < list.length; i++) {
      if (!frs[i]) continue; const cv = new OffscreenCanvas(132, 235); cv.getContext('2d').putImageData(new ImageData(frs[i], 132, 235), 0, 0);
      const name = `${K('_AM_STRIP_PREFIX')}${String(i).padStart(3, '0')}.jpg`; vfs.write('temp/' + name, await cv.convertToBlob({ type: 'image/jpeg', quality: 0.7 })); await vfs.flush('temp/' + name);
      out.push({ i, url: `temp/${name}?t=${stamp}` });
    }
    return { ok: true, frames: out };
  } catch (e) { log(`  ⚠ кадры сцен не сняты (${String(e.message || e).slice(0, 60)})`); return { ok: false }; }
};
P._am_seg_queries = async function () {
  if (this._am_seg_q) return this._am_seg_q;
  const segs = (this._am_ctx || {}).segs || []; if (!segs.length) { this._am_seg_q = []; return []; }
  const texts = segs.map(s => clean_phrase(s.text || ''));
  let qmap = {}; try { qmap = (await this._am_broll_queries(texts)) || {}; } catch (e) { log(`  ⚠ подсказки запросов не получены (${String(e.message || e).slice(0, 50)})`); }
  this._am_seg_q = segs.map((s, i) => ({ t: Math.round(Number(s.start || 0) * 100) / 100, e: Math.round(Number(s.end || 0) * 100) / 100, text: texts[i].slice(0, 90), q: qmap[i] || '' }));
  log(`  💡 подсказки «что показать»: ${this._am_seg_q.length} фраз, ${this._am_seg_q.filter(r => r.q).length} с запросом — вызовов ИИ 1`);
  return this._am_seg_q;
};
P.am_suggest_query = async function (t) {
  try {
    const rows = await this._am_seg_queries(); if (!rows.length) return { ok: false, msg: this._t('am_no_phrases') };
    t = Number(t || 0); const d = (r) => (r.t <= t && t <= r.e) ? 0 : Math.min(Math.abs(r.t - t), Math.abs(r.e - t));
    const best = rows.reduce((a, b) => d(b) < d(a) ? b : a);
    if (!best.q) return { ok: false, src: best.text || '', msg: this._t('am_nothing_visible') };
    return { ok: true, q: best.q, src: best.text || '' };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 120) }; }
};
P._am_ru2en = async function (q) {
  q = String(q || '').trim(); if (!q || !/[а-яёА-ЯЁ]/.test(q)) return q;
  const cache = (this._am_q_cache = this._am_q_cache || {}); const key = q.toLowerCase(); if (key in cache) return cache[key];
  let en = ''; try { en = (((await this._am_broll_queries([q])) || {})[0] || '').trim(); } catch (e) { en = ''; }
  if (en) { cache[key] = en; log(`  🔤 запрос «${q.slice(0, 34)}» → «${en}»`); } else log(`  ⚠ не удалось перевести запрос «${q.slice(0, 34)}» — ищу как есть`);
  return en || q;
};
P.am_broll_candidates = async function (q, source = 'pixabay', reset = false) {
  const en = await this._am_ru2en(q); if (!en) return { ok: false, msg: this._t('am_no_query') };
  if (!['pexels', 'pixabay'].includes(source)) source = 'pixabay';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !this.pixabay_keys.length) return { ok: false, msg: this._t('m2_no_key') };
  const st_all = (this._am_swap_state = this._am_swap_state || {}); const key = `${source}:${en}`; let st = st_all[key];
  if (reset || !st) { st = { hits: await this._swap_fetch_hits(source, en), offered: [] }; st_all[key] = st; }
  if (!st.hits.length) return { ok: false, q: en, msg: this._t(source === 'pexels' ? 'm1_empty' : 'm2_empty') };
  const add_n = st.offered.length ? 1 : 3; let added = 0;
  for (const h of st.hits) { if (added >= add_n) break; const hid = h.id; if (hid == null || st.offered.includes(hid)) continue; st.offered.push(hid); added++; }
  const by_id = new Map(st.hits.map(h => [h.id, h]));
  return { ok: true, q: en, candidates: st.offered.map(hid => ({ id: hid, source, thumb: Api._hit_thumb_url(by_id.get(hid) || {}) })), exhausted: added === 0, source };
};
P.am_broll_pick = async function (q, source, hit_id, want = 2.5, layout = 'split') {
  try {
    const en = await this._am_ru2en(q); const st = (this._am_swap_state || {})[`${source}:${en}`];
    if (!st) return { ok: false, msg: this._t('am_stale_variants') };
    const n = parseInt(hit_id); if (!Number.isNaN(n) && String(n) === String(hit_id)) hit_id = n;
    const hit = st.hits.find(h => h.id === hit_id); if (!hit) return { ok: false, msg: this._t('am_variant_not_found') };
    const vids = hit.videos || {}; let url = ''; for (const sz of ['medium', 'small', 'large', 'tiny']) { url = (vids[sz] || {}).url || ''; if (url) break; }
    if (!url) return { ok: false, msg: this._t('am_variant_no_video') };
    let hsh = 0; for (const ch of `${source}:${hit_id}`) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0; const seed = Math.abs(hsh) % 90000 + 1000;
    const raw = `temp/am_pick_${seed}.mp4`; await _download(url, raw);
    if (!vfs.exists(raw)) return { ok: false, msg: this._t('am_download_failed') };
    const lay = layout === 'split' ? 'split' : 'full';
    const clip = this._am_clip_from_file(raw, true, seed, want, lay); if (!clip) return { ok: false, msg: this._t('am_clip_failed') };
    const thumb = `temp/am_thumb_p${seed}.jpg`; await this._am_clip_thumb(clip, lay, thumb);
    log(`  ✅ вставка выбрана вручную из галереи (${source}, «${en.slice(0, 30)}»)`);
    return { ok: true, clip, q: en, clip_layout: lay, thumb: `${thumb}?t=${Math.trunc(now())}` };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 120) }; }
};
P.am_swap_broll = async function (q, seed, want = 2.0, layout = 'full') {
  try {
    q = String(q || '').trim(); if (!q) return { ok: false, msg: this._t('am_empty_query') };
    if (this.busy) return { ok: false, msg: this._t('am_busy') };
    if (!(this._am_used instanceof Set)) this._am_used = new Set();
    seed = parseInt(seed || 0) || Math.trunc(now() % 100000);
    const lay = layout === 'split' ? 'split' : 'full';
    const clip = await this._am_stock_clip(q, seed, Number(want || 2.0), lay); if (!clip) return { ok: false, msg: this._t('am_no_other_clip') };
    const thumb = `temp/am_thumb_s${seed}.jpg`;
    if (!(await this._am_clip_thumb(clip, lay, thumb))) return { ok: false, msg: this._t('am_frame_failed') };
    log(`  🔄 замена вставки «${q.slice(0, 40)}» → новый клип`);
    return { ok: true, clip, thumb: `${thumb}?t=${Math.trunc(now())}` };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 120) }; }
};
