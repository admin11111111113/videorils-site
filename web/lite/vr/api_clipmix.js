// Порт Api (Лайт): «Клип-микс» (Нарезка) — 15-400 коротких клипов по теме / своей папке под музыку,
// опц. озвученный хук (дакинг музыки), заголовок темы, превью кадров с заменой, подпись для поста.
import { C, log, re, vfs, path, call_js, bar, strftime, choice, shuffle } from './core.js';
import * as A from './audio.js';
import { makeThumb } from './thumbs.js';
import { cssFont } from './fonts.js';
import { _download } from './media.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const CM_VID = C['Api.CM_VID_EXT'], CM_IMG = C['Api.CM_IMG_EXT'];
const FOLDER_ROOT = 'input/cmfolder/';

P._gen_clipmix_caption = async function () {
  const theme = (this.clipmix_theme || '').trim();
  if (!theme) { this.clipmix_post_caption = ''; this.clipmix_post_tags = ''; return [false, 'no theme']; }
  const prompt = this.video_lang === 'en'
    ? 'This is a short vertical clip-mix video on the theme:\n' + theme + '\n\nWrite catchy text for publication. Return EXACTLY two lines and nothing else:\nDESC|catchy post caption (1-2 lines, intriguing, on the theme)\nTAGS|#tag1 #tag2 #tag3 #tag4 #tag5 (5-7 relevant hashtags)'
    : 'Это короткая вертикальная видео-нарезка на тему:\n' + theme + '\n\nПридумай цепляющий текст для публикации. Верни РОВНО две строки и больше ничего:\nDESC|цепляющая подпись для поста (1-2 строки, с интригой, под тему)\nTAGS|#тег1 #тег2 #тег3 #тег4 #тег5 (5-7 релевантных хэштегов)';
  let ok, out; try { [ok, out] = await this._ai_call(prompt, null, 800); } catch (e) { ok = false; out = String(e.message || e); }
  if (!ok) { this.clipmix_post_caption = ''; this.clipmix_post_tags = ''; return [false, out]; }
  const meta = this._parse_reel_answer(out)[4] || {};
  this.clipmix_post_caption = meta.caption || ''; this.clipmix_post_tags = meta.tags || '';
  return [true, ''];
};
P.get_clipmix_publish = function () { return { caption: this.clipmix_post_caption || '', tags: this.clipmix_post_tags || '' }; };
P.clipmix_regen_caption = async function () {
  const [ok, msg] = await this._gen_clipmix_caption();
  if (!ok) return { ok: false, msg, manual: true };
  return { ok: true, caption: this.clipmix_post_caption, tags: this.clipmix_post_tags };
};
// списочная тема -> конкретные пункты (англ. сток-запросы); однообъектная -> 1; сбой -> []
P._clipmix_decompose = async function (theme) {
  const prompt = `Тема видео-нарезки: «${theme}».\nЭто СПИСОЧНАЯ тема (несколько РАЗНЫХ конкретных визуальных объектов/мест/предметов/упражнений/этапов — «7 мест в Париже», «5 упражнений для пресса», «4 гаджета для путешествий», «5 этапов приготовления борща») ИЛИ ОДНООБЪЕКТНАЯ (ОДИН объект в разных ракурсах — «золотые самородки», «красивые водопады»)?\n• СПИСОЧНАЯ → перечисли её КОНКРЕТНЫЕ пункты как ТОЧНЫЕ английские сток-запросы. КАЖДЫЙ пункт — САМОДОСТАТОЧНЫЙ запрос с КОНТЕКСТОМ для точного попадания в сток: для мест добавь город/страну (Eiffel Tower Paris, Louvre Paris, Sacré-Cœur Paris basilica); для блюд — кухню/тип (Margherita pizza, spaghetti carbonara, tiramisu dessert); для упражнений — что это (plank exercise, russian twist workout). Реальные узнаваемые названия, 2–4 слова. Столько пунктов, сколько в теме (обычно 3–10), каждый — РАЗНЫЙ объект, который отдельно ищется в стоке.\n• ОДНООБЪЕКТНАЯ → верни РОВНО ОДИН запрос (сам объект по-английски).\nОтветь ТОЛЬКО валидным JSON-массивом английских строк, без markdown и пояснений.`;
  try {
    const [ok, out] = await this._ai_call(prompt, null, 400);
    if (!ok || !out) return [];
    const mt = /\[[\s\S]*\]/.exec(out); const arr = JSON.parse(mt ? mt[0] : out);
    const seen = new Set(), uniq = [];
    for (const x of (Array.isArray(arr) ? arr : [])) {
      const s = String(x).trim().replace(/^"+|"+$/g, '').replace(/^[«»]+|[«»]+$/g, '').trim();
      if (s && !/[а-яёА-ЯЁ]/.test(s) && s.length >= 2 && s.split(/\s+/).length <= 5 && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); uniq.push(s); }
    }
    return uniq;
  } catch (e) { log(`  ⚠ разложение темы нарезки не удалось: ${String(e.message || e).slice(0, 60)}`); return []; }
};
P._clipmix_queries = async function (theme, n) {
  const items = await this._clipmix_decompose(theme);
  if (items.length >= 2) {
    log(`  🧩 списочная тема → ${items.length} пунктов: ` + items.slice(0, 8).join(', ') + (items.length > 8 ? ' …' : ''));
    const shots = ['', 'close up', 'aerial view', 'wide shot', 'cinematic', 'detail', 'at night', 'slow motion'];
    const out = []; for (let i = 0; i < n; i++) { const item = items[i % items.length]; const suf = shots[Math.floor(i / items.length) % shots.length]; out.push((item + ' ' + suf).trim()); }
    return [out, ''];
  }
  const prompt = `Тема видео-нарезки: «${theme}».\nДай РОВНО ${n} КОРОТКИХ английских запросов для стокового видео (Pixabay/Pexels). Каждый запрос показывает ИМЕННО ГЛАВНЫЙ ОБЪЕКТ темы «${theme}» — крупно и узнаваемо.\n\nЖЁСТКИЕ ПРАВИЛА:\n- В КАЖДОМ запросе — точное английское название самого объекта темы (тема «самородки» → в каждом есть 'gold nugget'/'gold nuggets').\n- Варьируй ТИП КАДРА и деталь, а НЕ объект: close up / macro / on palm / on black background / rotating / pile of / holding / studio light — объект тот же.\n- ЗАПРЕЩЕНО уводить в СМЕЖНЫЕ сцены вокруг объекта: НЕ давай про реку/воду/ручей/водопад/промывку/пейзаж/горы/лес/людей/рабочих/лагерь, ЕСЛИ сама тема не про это. Клип показывает САМ предмет, а не место/процесс вокруг него.\n\nПРАВИЛА ЗАПРОСА:\n` + C._STOCK_QUERY_RULES + '\nВерни ТОЛЬКО запросы, по одному на строке, без нумерации и пояснений.';
  const [ok, out] = await this._ai_call(prompt, null, 1200);
  if (!ok) { log(`  ⚠ AI-запросы для нарезки не пришли: ${String(out).slice(0, 80)}`); return [[], out || '']; }
  const seen = new Set(), uniq = [];
  for (const line of String(out || '').split('\n')) {
    let s = line.trim().replace(/^[0-9.\-—)*•>#\t ]+/, '').trim();
    s = s.replace(/^"+|"+$/g, '').replace(/^[«»]+|[«»]+$/g, '').replace(/^[*`]+|[*`]+$/g, '').trim();
    if (!s || /[а-яёА-ЯЁ]/.test(s)) continue;
    if (s.length >= 3 && s.split(/\s+/).length <= 10 && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); uniq.push(s); }
  }
  const drift = new Set(['river', 'water', 'stream', 'waterfall', 'lake', 'ocean', 'sea', 'rain', 'panning', 'landscape', 'mountain', 'mountains', 'valley', 'forest', 'meadow', 'field', 'sunset', 'sunrise', 'reflection', 'prospector', 'prospectors', 'miner', 'miners', 'worker', 'workers', 'camp', 'tent', 'people', 'crowd']);
  const theme_toks = new Set((String(theme || '').toLowerCase().match(/[a-zа-яё]+/g) || []));
  const generic = new Set(['close', 'closeup', 'up', 'macro', 'shot', 'video', 'detail', 'view', 'footage', 'cinematic', 'slow', 'motion', 'aerial', 'studio', 'light', 'the', 'and', 'with', 'for', 'background']);
  const cnt = {};
  for (const q of uniq) for (const tok of new Set(q.toLowerCase().split(/\s+/))) if (tok.length > 2 && !generic.has(tok)) cnt[tok] = (cnt[tok] || 0) + 1;
  const ranked = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]); const top = ranked[0] || '';
  let clean;
  if (drift.has(top) && (cnt[top] || 0) >= 0.5 * uniq.length) clean = uniq;
  else {
    const live = [...drift].filter(d => !theme_toks.has(d));
    const anchored = uniq.filter(q => !q.toLowerCase().split(/\s+/).some(t => live.includes(t)));
    clean = anchored.length ? anchored : uniq;
  }
  if (clean.length < uniq.length) log(`  🎯 нарезка: отфильтровано ${uniq.length - clean.length} запросов-дрейфов (вода/место/люди не по теме «${theme}»)`);
  return [clean.slice(0, n), ''];
};
// заголовок темы нарезки в стиле выбранных субтитров (drawtext: обводка 6, плашка keycss@0.5, boxborderw 20)
P._caption_overlay = function (text) {
  const txt = String(text || '').trim().toUpperCase(); if (!txt) return null;
  const fs = Math.max(28, Math.trunc(1920 * (this.clipmix_cap_fontpct ?? 0.052)));
  const xp = this.clipmix_cap_xpct ?? 0.5, yp = this.clipmix_cap_ypct ?? 0.86;
  const st = C.STYLES[this.reel_style % C.STYLES.length];
  const fc = '#' + String(st.css || '#FFFFFF').replace('#', '').slice(0, 6), boxc = '#' + String(st.keycss || '#000000').replace('#', '').slice(0, 6);
  const lines = txt.split('\n');
  return (ctx, tc, W, H) => {
    ctx.save(); ctx.font = cssFont('Arial Black', fs); ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width)); const th = lines.length * fs + (lines.length - 1) * 8;
    const x = W * xp - tw / 2, y = H * yp - th / 2;
    ctx.globalAlpha = 0.5; ctx.fillStyle = boxc; ctx.fillRect(x - 20, y - 20, tw + 40, th + 40); ctx.globalAlpha = 1;
    lines.forEach((l, i) => { const yy = y + i * (fs + 8); ctx.strokeStyle = '#000'; ctx.lineWidth = 12; ctx.strokeText(l, x, yy); ctx.fillStyle = fc; ctx.fillText(l, x, yy); });
    ctx.restore();
  };
};
// ПЛАН нарезки (единый для превью и сборки): [{src,is_video,start,origin,query}]
P._clipmix_plan = async function (theme, pool_surplus = false) {
  this._reel_used_clips = new Set();
  theme = String(theme || '').trim(); if (!theme) throw new Error(this._t('cm_empty_theme'));
  const src_mode = this.clipmix_source || 'auto'; const folder = (this.clipmix_folder || '').trim();
  const use_folder = ['folder', 'both'].includes(src_mode) && folder; const use_stock = ['auto', 'both'].includes(src_mode);
  if (src_mode === 'folder') { if (!(folder && this._folder_files().length)) throw new Error(this._t('cm_no_folder')); }
  else if (!this._has_stock()) throw new Error(this._t('cm_need_media_key'));
  const length = Math.max(5, Math.min(120, parseInt(this.clipmix_len) || 20));
  const cps = [0.5, 1, 2, 3].includes(this.clipmix_cps) ? this.clipmix_cps : 2;
  const base_dur = Math.round(1000 / cps) / 1000; const n_clips = Math.max(6, Math.min(400, Math.round(length * cps)));
  log(`▶ Нарезка «${theme}» [источник: ${src_mode}]: ${n_clips} клипов × ${base_dur.toFixed(2)}с ≈ ${length}с`);
  this._reset_scene_media(false); this.reel_topic = theme;
  const frames = Math.max(1, Math.round(base_dur * 30));
  const surplus = pool_surplus ? Math.max(12, Math.min(30, Math.round(n_clips * 0.8))) : 0; const pool_total = n_clips + surplus;
  let folder_target, stock_target;
  if (src_mode === 'both') { folder_target = Math.floor((pool_total + 1) / 2); stock_target = pool_total - folder_target; }
  else if (use_folder) { folder_target = pool_total; stock_target = 0; } else { folder_target = 0; stock_target = pool_total; }
  let folder_moments = [], stock_moments = [], files = [];
  if (folder_target && use_folder) {
    files = shuffle(this._scan_media_folder(folder).filter(f => vfs.size(f.path) > 0));
    if (!files.length && src_mode === 'folder') throw new Error(this._t('cm_no_files_in_folder'));
    if (files.length) {
      const [fm, fstats] = await this._folder_moments(files, folder_target, base_dur); folder_moments = fm;
      log(`  📁 своя папка: ${fstats.n_files} файлов (видео ${fstats.videos} + фото ${fstats.photos}) → ${folder_moments.length} моментов (цель ${folder_target})`);
      for (const pf of fstats.per_file) log(`     • ${pf.type} «${pf.name}»: использован ${pf.used}× (доступно точек ${pf.points})`);
    }
  }
  if (stock_target && use_stock) {
    const need = stock_target; bar(4, 'Генерирую ракурсы…');
    const n_q = Math.max(18, Math.min(45, need));
    const [queries, qerr] = await this._clipmix_queries(theme, n_q);
    if (!queries.length && !folder_moments.length) throw new Error(qerr || this._t('cm_no_queries'));
    log(`  🎬 ракурсов темы: ${queries.length}`);
    const pool = [];
    for (let qi = 0; qi < queries.length; qi++) {
      if (pool.length >= need) break;
      const q = queries[qi];
      bar(6 + Math.trunc((qi + 1) / Math.max(1, queries.length) * 40), `Источник ${qi + 1}/${queries.length}…`);
      let src = null, isv = null;
      try { [src, isv] = await this._download_pixabay(q, `pl${String(qi).padStart(3, '0')}`); } catch (e) { log(`  ⚠ источник «${q}» не вышел (${String(e.message || e).slice(0, 40)})`); continue; }
      if (src && vfs.size(src) > 0) pool.push({ src, is_video: !!isv, query: q });
    }
    if (pool.length) { stock_moments = this._stock_moments(pool, need, base_dur).slice(0, need); log(`  🎬 автоподбор: ${pool.length} источников → ${stock_moments.length} моментов (цель ${stock_target})`); }
  }
  if (src_mode === 'both') {
    const s_short = stock_target - stock_moments.length;
    if (s_short > 0 && files.length) { const [extra] = await this._folder_moments(files, s_short, base_dur); folder_moments = folder_moments.concat(extra); log(`  ⚠ стока по теме мало (${stock_moments.length}/${stock_target}) — добрал ${extra.length} своими (микс сместился к папке)`); }
  }
  for (const m of folder_moments) m.origin = 'папка';
  for (const m of stock_moments) m.origin = 'сток';
  let all_cand = folder_moments.concat(stock_moments);
  if (['both', 'folder'].includes(src_mode)) shuffle(all_cand);
  if (!all_cand.length) throw new Error(this._t('cm_no_frames'));
  if (all_cand.length < Math.max(6, Math.floor(n_clips / 2))) throw new Error(this._t('cm_not_enough_material'));
  const seen_k = new Set(), pool = [];
  for (const m of all_cand) { const k = Api._moment_key(m); if (!seen_k.has(k)) { seen_k.add(k); pool.push(m); } }
  this.clipmix_pool = pool;
  const moments = all_cand.slice(0, n_clips);
  const nv = moments.filter(m => m.is_video).length, pv = pool.filter(m => m.is_video).length;
  log(`  🎞 слотов ${n_clips}; пул кандидатов ${pool.length} (видео ${pv} + фото ${pool.length - pv}); размещено ${moments.length} (видео ${nv} + фото ${moments.length - nv})`);
  if (src_mode === 'both') { const nfold = moments.filter(m => m.origin === 'папка').length; log(`  🎯 микс «Свои + автоподбор»: папка ${nfold} / сток ${moments.length - nfold}; источники по клипам: ${moments.map(m => m.origin === 'папка' ? 'П' : 'С').join('')}`); }
  return [moments, { base_dur, frames, n_clips, src_mode, length, theme }];
};
// звук нарезки: музыка (volume dB, fade 2с) + хук; при хуке — дакинг музыки (sidechaincompress thr .05 ratio 8 att 20 rel 500)
async function mixClipmixAudio(vlen, musicBuf, music_db, hookBuf) {
  const sr = 44100, N = Math.max(1, Math.round(vlen * sr)); const out = new AudioBuffer({ numberOfChannels: 2, length: N, sampleRate: sr });
  const fade0 = Math.max(0, vlen - 2.0); const mg = A.dbToGain(music_db);
  let env = null;
  if (hookBuf) {
    const h = hookBuf.getChannelData(0); env = new Float32Array(N); let e = 0;
    const att = 1 - Math.exp(-1 / (0.020 * sr)), rel = 1 - Math.exp(-1 / (0.500 * sr));
    for (let i = 0; i < N; i++) { const x = i < h.length ? Math.abs(h[i]) : 0; e += (x > e ? att : rel) * (x - e); env[i] = e; }
  }
  for (let ch = 0; ch < 2; ch++) {
    const o = out.getChannelData(ch);
    if (musicBuf) {
      const m = musicBuf.getChannelData(Math.min(ch, musicBuf.numberOfChannels - 1)); const L = m.length;
      for (let i = 0; i < N; i++) {
        let g = mg; const t = i / sr; if (t >= fade0) g *= Math.max(0, 1 - (t - fade0) / 2.0);
        if (env) { const thr = 0.05; const ev = env[i]; if (ev > thr) g *= (thr + (ev - thr) / 8) / ev; }
        o[i] = m[i % L] * g;
      }
    }
    if (hookBuf) { const h = hookBuf.getChannelData(Math.min(ch, hookBuf.numberOfChannels - 1)); for (let i = 0; i < Math.min(N, h.length); i++) o[i] += h[i]; }
  }
  return out;
}
P._build_clipmix_worker = async function () {
  this.busy = true; this._BUILD_DEGRADED = [];
  const { _pix_reset_counters } = await import('./media.js'); _pix_reset_counters();
  try {
    let moments, meta, base_dur, frames, theme;
    const approved = this.clipmix_moments;
    if (approved && approved.length) {
      moments = [...approved]; meta = this._clipmix_meta || {};
      base_dur = meta.base_dur || Math.round(1000 / (this.clipmix_cps || 2)) / 1000; frames = meta.frames || Math.max(1, Math.round(base_dur * 30));
      theme = meta.theme || (this.clipmix_theme || '').trim(); this.reel_topic = theme; this._reel_used_clips = new Set(); this._reset_scene_media(false);
      log(`▶ Нарезка «${theme}» из ОДОБРЕННОГО превью: ${moments.length} кадров`);
    } else {
      [moments, meta] = await this._clipmix_plan(this.clipmix_theme);
      base_dur = meta.base_dur; frames = meta.frames; theme = meta.theme;
    }
    const clips = [];
    for (let i = 0; i < moments.length; i++) {
      const mo = moments[i];
      if (mo.src && vfs.exists(mo.src)) clips.push({ kind: mo.is_video ? 'video' : 'image', blob: vfs.read(mo.src), frames, start: Number(mo.start || 0) || 0, kb: i });
      else log(`  ⚠ слот ${i + 1} не вышел (нет файла)`);
      bar(46 + Math.trunc((i + 1) / moments.length * 26), `Кадр ${i + 1}/${moments.length}…`);
    }
    if (!clips.length) throw new Error(this._t('cm_no_frames_assembled'));
    bar(74, 'Склейка…');
    const vlen = clips.reduce((a, c) => a + c.frames, 0) / 30;
    log(`▶ Собрано ${clips.length} клипов, ${vlen.toFixed(1)}с`);
    let hookBuf = null; const hook = (this.clipmix_hook || '').trim();
    if (hook) {
      try {
        const hp = 'temp/cm_hook.mp3';
        const [_say, _ks] = await this._merge_manual_stress(hook, this.clipmix_hook_stress || '', this.clipmix_hook_stress_manual || null);
        await this._synth_one(_say, hp, { keep_stress: _ks });
        if (vfs.size(hp) > 0) { hookBuf = await A.resample(await A.decode(hp), 44100, 2); log(`▶ Хук: «${hook.slice(0, 40)}»`); }
      } catch (e) { log(`  ⚠ хук не озвучился (${String(e.message || e).slice(0, 40)}) — без него`); }
    }
    bar(80, 'Музыка…');
    const music = this._pick_music(vlen, this.clipmix_music); let musicBuf = null;
    if (music && vfs.exists(music)) { try { musicBuf = await A.resample(await A.decode(music), 44100, 2); log(`▶ Музыка «${path.basename(music)}» (${this.music_db}dB)`); } catch (e) { musicBuf = null; } }
    else log('▶ Без музыки (можно выбрать трек в настройках нарезки)');
    if (musicBuf && hookBuf) log('▶ Дакинг музыки под голос хука (авто)');
    const audio = await mixClipmixAudio(vlen, musicBuf, this.music_db, hookBuf);
    bar(88, 'Подпись…');
    const overlay = this.clipmix_caption_on ? this._caption_overlay(this.clipmix_caption || theme) : null;
    const outro = await this._outro_spec();
    const logo = await this._logo_spec(1080, 1920);
    const { renderReel } = await import('./engine.js');
    bar(90, 'Рендер видео…');
    const res = await renderReel({ W: 1080, H: 1920, clips, voice: audio, overlay, outro, logo, fit: { r: 1, trimTo: null }, metaTitle: 'VideoRils Lite',
      onProgress: (f) => bar(90 + Math.trunc(f * 8), `Рендер ${Math.trunc(f * 100)}%…`) });
    const out_name = `cut_${strftime('%H%M%S')}${res.ext}`; const out_path = `output/${out_name}`;
    vfs.write(out_path, res.blob); await vfs.flush(out_path);
    this.last_reel = out_path;
    log(`✅ Нарезка готова: ${out_name}`);
    this._ping_render();
    if (!this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    try { await this._gen_clipmix_caption(); } catch (e) { }
    bar(100, 'Готово');
    this._emit_pix_limit();
    call_js('clipmixDone', out_path, '', (this._BUILD_DEGRADED || []).length);
    return out_path;
  } catch (e) {
    log(`✖ Ошибка нарезки: ${e.message || e}`);
    call_js('clipmixDone', '', String(e.message || e).slice(0, 200));
    return null;
  } finally { this.busy = false; this._reel_used_clips = null; }
};
P._clipmix_guard = function (theme) {
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  this.clipmix_theme = String(theme || '').trim();
  return null;
};
P._clipmix_src_check = function () {
  if (!this.clipmix_theme) return { ok: false, msg: this._t('cm_msg_need_theme') };
  const src_mode = this.clipmix_source || 'auto'; const folder = (this.clipmix_folder || '').trim();
  if (src_mode === 'folder') { if (!folder || !this._folder_files().length) return { ok: false, msg: this._t('cm_msg_need_folder') }; }
  else if (!this._has_stock()) return { ok: false, msg: this._t('cm_msg_need_media_key') };
  return null;
};
P.build_clipmix = function (theme, from_preview = false) {
  const g = this._clipmix_guard(theme); if (g) return g;
  if (!from_preview) this.clipmix_moments = null;
  const c = this._clipmix_src_check(); if (c) return c;
  this._persist(); this._build_clipmix_worker();
  return { ok: true };
};
P.clipmix_preview = function (theme) {
  const g = this._clipmix_guard(theme); if (g) return g;
  const c = this._clipmix_src_check(); if (c) return c;
  this._persist(); this._clipmix_preview_worker();
  return { ok: true };
};
P._clipmix_preview_worker = async function () {
  this.busy = true;
  try {
    const [moments, meta] = await this._clipmix_plan(this.clipmix_theme, true);
    this.clipmix_moments = moments; this._clipmix_meta = meta;
    const items = []; for (let i = 0; i < moments.length; i++) items.push(await this._clipmix_prev_item(moments[i], i));
    call_js('clipmixPreviewReady', { ok: true, items, seconds: meta.length || 0, count: items.length });
  } catch (e) { call_js('clipmixPreviewReady', { ok: false, msg: String(e.message || e) }); }
  finally { this.busy = false; }
};
P._clipmix_prev_item = async function (mo, i) {
  if (!mo.thumb) await this._clipmix_thumb(mo);
  return { i, is_video: !!mo.is_video, origin: mo.origin || '', name: path.basename(mo.src || '').replace(/^cm\d+_/, ''), thumb: mo.thumb || '' };
};
// миниатюра момента: стабильное имя cmprev_{seq}.jpg (не по индексу)
P._clipmix_thumb = async function (mo) {
  const seq = (this._cm_thumb_seq || 0) + 1; this._cm_thumb_seq = seq;
  const name = `cmprev_${String(seq).padStart(4, '0')}.jpg`; let url = '';
  try { await makeThumb(mo.src, 'temp/' + name, 220, mo.is_video ? Number(mo.start || 0) : 0); if (vfs.size('temp/' + name) > 0) url = 'temp/' + name; } catch (e) { }
  mo.thumb = url; return url;
};
// ключ дедупа: фото = файл; видео = файл + таймкод
Api._moment_key = function (mo) { const src = String(mo.src || '').toLowerCase(); return mo.is_video ? `${src}|${Math.round(Number(mo.start || 0) * 10) / 10}` : src; };
P._moment_key = Api._moment_key;
P._clipmix_items = async function () { const out = []; const ms = this.clipmix_moments || []; for (let i = 0; i < ms.length; i++) out.push(await this._clipmix_prev_item(ms[i], i)); return out; };
P.clipmix_prev_remove = async function (i) {
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return { ok: false, msg: this._t('cm_msg_no_frame') };
  ms.splice(i, 1);
  if (!ms.length) return { ok: false, empty: true, msg: this._t('cm_msg_all_removed') };
  return { ok: true, items: await this._clipmix_items(), count: ms.length };
};
// 🔄 другой клип для кадра i: '' -> из пула; 'pixabay'|'pexels' -> свежий из выбранного источника
P.clipmix_prev_replace = async function (i, source = '') {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return { ok: false, msg: this._t('cm_msg_no_frame') };
  const cur = ms[i]; const cur_key = Api._moment_key(cur);
  const used = new Set(ms.filter((m, j) => j !== i).map(Api._moment_key));
  const src_sel = String(source || '').trim().toLowerCase();
  if (['pixabay', 'pexels'].includes(src_sel)) {
    if (src_sel === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
    if (src_sel === 'pixabay' && !this.pixabay_keys.length) return { ok: false, msg: this._t('m2_no_key') };
    try {
      const q = cur.query || this.clipmix_theme; this._cm_rep = (this._cm_rep || 0) + 1; const tag = `rp${String(this._cm_rep).padStart(4, '0')}`;
      const [nsrc, isv] = src_sel === 'pexels' ? await this._pexels_download(q, tag) : await this._download_pixabay(q, tag);
      if (!(nsrc && vfs.size(nsrc) > 0)) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
      const newmo = { src: nsrc, is_video: !!isv, start: 0.0, origin: 'сток', query: q, provider: src_sel };
      const nk = Api._moment_key(newmo); if (nk === cur_key || used.has(nk)) return { ok: false, msg: this._t('cm_msg_no_more_clips') };
      newmo.thumb = ''; ms[i] = newmo; await this._clipmix_thumb(newmo);
      this.clipmix_pool = (this.clipmix_pool || []).concat([Object.assign({}, newmo)]);
      return { ok: true, item: await this._clipmix_prev_item(newmo, i) };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  }
  const is_photo = !cur.is_video; const pool = this.clipmix_pool || []; const cands = [], seen = new Set();
  for (const m of pool) { if ((!m.is_video) !== is_photo) continue; const k = Api._moment_key(m); if (used.has(k) || k === cur_key || seen.has(k)) continue; seen.add(k); cands.push(m); }
  if (cands.length) {
    const pick = Object.assign({}, choice(cands)); if (!pick.origin) pick.origin = cur.origin || 'сток'; pick.thumb = '';
    ms[i] = pick; await this._clipmix_thumb(pick);
    return { ok: true, item: await this._clipmix_prev_item(pick, i), left: cands.length - 1 };
  }
  if (is_photo) return { ok: false, no_more_photos: true, msg: this._t('cm_msg_no_more_photos') };
  if (cur.origin === 'папка') return { ok: false, msg: this._t('cm_msg_no_more_video') };
  try {
    const q = cur.query || this.clipmix_theme; this._cm_rep = (this._cm_rep || 0) + 1;
    const [src, isv] = await this._download_pixabay(q, `rp${String(this._cm_rep).padStart(4, '0')}`);
    if (!(src && vfs.size(src) > 0)) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
    const newmo = { src, is_video: !!isv, start: 0.0, origin: 'сток', query: q };
    const nk = Api._moment_key(newmo); if (nk === cur_key || used.has(nk)) return { ok: false, msg: this._t('cm_msg_no_more_clips') };
    newmo.thumb = ''; ms[i] = newmo; await this._clipmix_thumb(newmo);
    this.clipmix_pool = pool.concat([Object.assign({}, newmo)]);
    return { ok: true, item: await this._clipmix_prev_item(newmo, i) };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.clipmix_swap_candidates = async function (i, source = 'pixabay') {
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return { ok: false, msg: this._t('cm_msg_no_frame') };
  if (!['pixabay', 'pexels'].includes(source)) source = 'pixabay';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !this.pixabay_keys.length) return { ok: false, msg: this._t('m2_no_key') };
  const q = ms[i].query || this.clipmix_theme || 'background';
  const state = (this._cm_swap_state = this._cm_swap_state || {}); let st = state[i];
  if (!st || st.source !== source || st.q !== q) { st = { source, q, hits: await this._swap_fetch_hits(source, q), offered: [] }; state[i] = st; }
  if (!st.hits.length) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
  const add_n = st.offered.length ? 1 : 3; let added = 0;
  for (const h of st.hits) { if (added >= add_n) break; const hid = h.id; if (hid == null || st.offered.includes(hid)) continue; st.offered.push(hid); added++; }
  const by_id = new Map(st.hits.map(h => [h.id, h]));
  return { ok: true, candidates: st.offered.map(hid => ({ id: hid, source, thumb: Api._hit_thumb_url(by_id.get(hid) || {}) })), exhausted: added === 0, source };
};
P.clipmix_swap_restart = async function (i, source = 'pixabay') { const st = (this._cm_swap_state || {})[i]; if (st && st.source === source) st.offered = []; return await this.clipmix_swap_candidates(i, source); };
P.clipmix_pick_candidate = async function (i, source, hit_id) {
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return { ok: false, msg: this._t('cm_msg_no_frame') };
  const st = (this._cm_swap_state || {})[i]; if (!st) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
  const n = parseInt(hit_id); if (!Number.isNaN(n) && String(n) === String(hit_id)) hit_id = n;
  const hit = st.hits.find(h => h.id === hit_id); if (!hit) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
  const vids = hit.videos || {}; const v = vids.medium || vids.small || vids.tiny || vids.large;
  if (!v || !v.url) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
  try {
    this._cm_rep = (this._cm_rep || 0) + 1; const dst = `temp/cmpick_${i}_${String(this._cm_rep).padStart(4, '0')}.mp4`;
    await _download(v.url, dst);
    if (!(vfs.size(dst) > 0)) return { ok: false, msg: this._t('cm_msg_no_other_clip') };
    const newmo = { src: dst, is_video: true, start: 0.0, origin: 'сток', query: st.q, provider: source, hit_id: hit.id, thumb: '' };
    ms[i] = newmo; await this._clipmix_thumb(newmo);
    this.clipmix_pool = (this.clipmix_pool || []).concat([Object.assign({}, newmo)]);
    log(`  🎬 нарезка кадр ${i + 1}: выбран клип от ${source === 'pexels' ? 'Pexels' : 'Pixabay'} → id ${hit.id}`);
    return { ok: true, item: await this._clipmix_prev_item(newmo, i) };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.clipmix_prev_own_file = function (i) {
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return Promise.resolve({ ok: false, msg: this._t('cm_msg_no_frame') });
  return pickFilesLocal('video/*,image/*,.mp4,.mov,.mkv,.webm,.avi,.jpg,.jpeg,.png').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    const f = files[0]; const ext = path.splitext(f.name)[1].toLowerCase();
    const p = `input/cmown_${Date.now()}_${f.name}`; vfs.write(p, f);
    const mo = ms[i]; Object.assign(mo, { src: p, is_video: ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext), start: 0.0, origin: 'свой', query: '', thumb: '' });
    await this._clipmix_thumb(mo);
    return { ok: true, item: await this._clipmix_prev_item(mo, i) };
  });
};
P.clipmix_prev_play = async function (i) {
  const ms = this.clipmix_moments || []; if (!(i >= 0 && i < ms.length)) return { ok: false, msg: this._t('cm_msg_no_frame') };
  const mo = ms[i]; const src = mo.src || '';
  if (!(src && vfs.exists(src))) return { ok: false, msg: this._t('cm_msg_frame_file_missing') };
  const ext = path.splitext(src)[1].toLowerCase(); const is_video = !!mo.is_video || ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext);
  const dst = `temp/cmplay_${String(i).padStart(3, '0')}${is_video ? '.mp4' : (ext || '.jpg')}`; vfs.copy(src, dst); await vfs.flush(dst);
  this._thumb_tick = (this._thumb_tick || 0) + 1;
  return { ok: true, kind: is_video ? 'video' : 'image', url: `temp/${path.basename(dst)}?t=${this._thumb_tick}` };
};
// «своя папка» = выбранная в браузере папка (файлы в памяти страницы, input/cmfolder/…)
P._folder_files = function () { return vfs.list(FOLDER_ROOT); };
P._scan_media_folder = function (folder, count_only = false) {
  const vids = [], imgs = [];
  for (const p of this._folder_files()) { const ext = path.splitext(p)[1].toLowerCase(); if (CM_VID.includes(ext)) vids.push(p); else if (CM_IMG.includes(ext)) imgs.push(p); }
  if (count_only) return [vids.length, imgs.length];
  return vids.map(p => ({ path: p, is_video: true })).concat(imgs.map(p => ({ path: p, is_video: false })));
};
P.get_clipmix_settings = function () {
  const folder = this.clipmix_folder || ''; let nv = 0, nf = 0; if (folder) [nv, nf] = this._scan_media_folder(folder, true);
  return { theme: this.clipmix_theme || '', cps: this.clipmix_cps ?? 2, len: this.clipmix_len ?? 20, caption: this.clipmix_caption || '', caption_on: !!this.clipmix_caption_on,
    caption_pos: this.clipmix_caption_pos || 'top', cap_xpct: this.clipmix_cap_xpct ?? 0.5, cap_ypct: this.clipmix_cap_ypct ?? 0.86, cap_fontpct: this.clipmix_cap_fontpct ?? 0.052,
    hook: this.clipmix_hook || '', source: this.clipmix_source || 'auto', folder, n_video: nv, n_photo: nf };
};
P.set_clipmix_source = function (src) { this.clipmix_source = ['auto', 'folder', 'both'].includes(src) ? src : 'auto'; this._persist(); return { ok: true, source: this.clipmix_source }; };
P.reset_clipmix = function () { this.clipmix_theme = ''; this.clipmix_moments = null; this.clipmix_pool = []; this.clipmix_music = ''; this.clipmix_post_caption = ''; this.clipmix_post_tags = ''; this._persist(); return { ok: true }; };
P.set_clipmix_caption_on = function (on) {
  this.clipmix_caption_on = !!on;
  if (this.clipmix_caption_on && (this.clipmix_cap_ypct ?? 0.12) > 0.5) { this.clipmix_cap_xpct = 0.5; this.clipmix_cap_ypct = 0.12; }
  this._persist();
  return { ok: true, on: this.clipmix_caption_on, cap_xpct: this.clipmix_cap_xpct, cap_ypct: this.clipmix_cap_ypct };
};
function pickFilesLocal(accept, dir = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input'); inp.type = 'file'; if (accept) inp.accept = accept; if (dir) { inp.webkitdirectory = true; inp.multiple = true; }
    inp.style.display = 'none'; document.body.appendChild(inp); let done = false;
    const fin = (v) => { if (done) return; done = true; try { inp.remove(); } catch (e) { } resolve(v); };
    inp.addEventListener('change', () => fin(inp.files && inp.files.length ? [...inp.files] : null));
    inp.addEventListener('cancel', () => fin(null));
    window.addEventListener('focus', () => setTimeout(() => { if (!inp.files || !inp.files.length) fin(null); }, 1500), { once: true });
    inp.click();
  });
}
P.pick_clipmix_folder = function () {
  return pickFilesLocal('', true).then((files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    for (const k of this._folder_files()) vfs.remove(k);
    let root = '';
    files.forEach((f, i) => {
      const rel = f.webkitRelativePath || f.name; if (!root) root = rel.split('/')[0] || 'folder';
      const ext = path.splitext(f.name)[1].toLowerCase(); if (!CM_VID.includes(ext) && !CM_IMG.includes(ext)) return;
      vfs.write(FOLDER_ROOT + `cm${i}_` + f.name, f);
    });
    const [nv, nf] = this._scan_media_folder(root, true);
    this.clipmix_folder = root;
    if (this.clipmix_source === 'auto') this.clipmix_source = 'folder';
    this._persist();
    return { ok: true, folder: root, n_video: nv, n_photo: nf, source: this.clipmix_source };
  });
};
P.clear_clipmix_folder = function () { for (const k of this._folder_files()) vfs.remove(k); this.clipmix_folder = ''; this.clipmix_source = 'auto'; this._persist(); return { ok: true }; };
// моменты из файлов папки: фото — 1 показ; видео — несколько разнесённых точек; добор с видео
P._folder_moments = async function (files, n_clips, base_dur) {
  const nfiles = files.length;
  if (!nfiles) return [[], { n_files: 0, taken: [], photos: 0, videos: 0, per_file: [] }];
  const vids = files.map((f, i) => f.is_video ? i : -1).filter(i => i >= 0); const n_photo = nfiles - vids.length;
  const need_from_video = Math.max(0, n_clips - n_photo);
  const kv = vids.length ? Math.min(40, Math.max(1, Math.ceil(need_from_video / Math.max(1, vids.length)))) : 0;
  const min_step = Math.max(base_dur * 1.5, 1.2);
  const { mediaDur } = await import('./frames.js');
  const per = new Array(nfiles);
  for (let i = 0; i < nfiles; i++) {
    const f = files[i];
    if (f.is_video) {
      const dur = (await mediaDur(f.path).catch(() => 0)) || 0.0; const usable = Math.max(0.0, dur - base_dur);
      const k = usable < min_step ? 1 : Math.min(kv, Math.max(1, Math.floor(usable / min_step)));
      let pts;
      if (k <= 1) pts = [0.0];
      else { const step = usable / k; const raw = [...Array(k).keys()].map(j => Math.round(Math.min(usable, j * step) * 100) / 100); const order = [...Array(k).keys()].filter(j => j % 2 === 0).concat([...Array(k).keys()].filter(j => j % 2 === 1)); pts = order.map(j => raw[j]); }
      per[i] = pts.map(s => ({ src: f.path, is_video: true, start: s }));
    } else per[i] = [{ src: f.path, is_video: false, start: 0.0 }];
  }
  const order_files = shuffle([...Array(nfiles).keys()]); const ptr = new Array(nfiles).fill(0), taken = new Array(nfiles).fill(0); const moments = [];
  while (moments.length < n_clips) {
    let progressed = false;
    for (const i of order_files) { if (moments.length >= n_clips) break; if (ptr[i] < per[i].length) { moments.push(per[i][ptr[i]]); ptr[i]++; taken[i]++; progressed = true; } }
    if (!progressed) break;
  }
  let guard = 0;
  if (moments.length < n_clips) {
    let rep = order_files.filter(i => files[i].is_video); if (!rep.length) rep = order_files;
    while (moments.length < n_clips && guard < n_clips * 3 + 16) { guard++; for (const i of rep) { if (moments.length >= n_clips) break; moments.push(Object.assign({}, per[i][ptr[i] % per[i].length])); ptr[i]++; taken[i]++; } }
  }
  const stats = { n_files: nfiles, taken, photos: n_photo, videos: vids.length, per_file: files.map((f, i) => ({ name: path.basename(f.path).replace(/^cm\d+_/, ''), type: f.is_video ? 'видео' : 'фото', used: taken[i], points: per[i].length })) };
  return [moments.slice(0, n_clips), stats];
};
// моменты из стока: round-robin по источникам; повтор — с другого момента видео
P._stock_moments = function (pool_clips, need, base_dur) {
  const Pn = pool_clips.length; const out = []; if (!Pn) return out;
  for (let i = 0; i < need; i++) { const it = pool_clips[i % Pn]; const rep = Math.floor(i / Pn); const start = (rep === 0 || !it.is_video) ? 0.0 : Math.round(rep * (base_dur + 0.7) * 100) / 100; out.push({ src: it.src, is_video: it.is_video, start, query: it.query || '' }); }
  return out;
};
P.set_clipmix_cps = function (n) { const v = parseFloat(n); this.clipmix_cps = [0.5, 1, 2, 3].includes(v) ? v : 2; this._persist(); return { cps: this.clipmix_cps }; };
P.set_clipmix_len = function (n) { const v = parseInt(n); this.clipmix_len = Number.isNaN(v) ? 20 : Math.max(5, Math.min(120, v)); this._persist(); return { len: this.clipmix_len }; };
P.set_clipmix_caption = function (text) { this.clipmix_caption = String(text || '').trim().slice(0, 80); this._persist(); return { caption: this.clipmix_caption }; };
P.set_clipmix_caption_pos = function (pos) { this.clipmix_caption_pos = ['top', 'center', 'bottom'].includes(pos) ? pos : 'bottom'; this._persist(); return { pos: this.clipmix_caption_pos }; };
P.set_clipmix_caption_xy = function (x, y) { const a = parseFloat(x), b = parseFloat(y); if (!Number.isNaN(a) && !Number.isNaN(b)) { this.clipmix_cap_xpct = Math.max(0, Math.min(1, a)); this.clipmix_cap_ypct = Math.max(0, Math.min(1, b)); this._persist(); } return { xpct: this.clipmix_cap_xpct, ypct: this.clipmix_cap_ypct }; };
P.set_clipmix_caption_fontsize = function (pct) { const v = parseFloat(pct); if (!Number.isNaN(v)) { this.clipmix_cap_fontpct = Math.max(0.025, Math.min(0.12, v)); this._persist(); } return { fontpct: this.clipmix_cap_fontpct }; };
P.set_clipmix_hook = function (text) {
  const nw = String(text || '').trim().slice(0, 120);
  if (nw !== (this.clipmix_hook || '')) { this.clipmix_hook_stress = ''; this.clipmix_hook_stress_manual = []; }
  this.clipmix_hook = nw; this._persist(); return { hook: this.clipmix_hook };
};
