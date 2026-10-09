// Порт Api: build_reel, озвучка фраз, _build_reel_worker, подгонка длины, финальный кадр,
// результат/просмотр (app.py 11037–12204, 12749–12900).
import { C, log, re, vfs, path, call_js, bar, now, strftime, sleep, _build_log_open, _build_log_close, choice, pysplit, APP_VERSION , mimeOf } from './core.js';
import { build_ass } from './textutil.js';
import { download_media, _download, PIX, _pix_reset_counters } from './media.js';
import { probeOk } from './thumbs.js';
import * as A from './audio.js';
import { renderReel, outroAudio } from './engine.js';
import { _RevoiceAll } from './api_tts.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const { STYLES, EMOTIONS } = C;

// ---- «деградации сборки» (видимые оговорки) ----
P._degrade = function (msg) { (this._BUILD_DEGRADED = this._BUILD_DEGRADED || []).push(String(msg)); log('  ⚠ ' + msg); };

P._has_stock = async function () { return !!((await this._active_pixabay_key()) || this.pexels_key); };

P.build_reel = async function (claude_answer, style_index) {
  this.track('generate_started');
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  if (this.reel_source === 'foreign' && !this.foreign_segments.length) return { ok: false, code: 'foreign_no_text', msg: this._t('foreign_no_text') };
  if ((claude_answer || '').trim()) this.parse_to_scenes(claude_answer);
  let _voiced = this.reel_scenes.filter(s => s.text.trim());
  const _dd = [];
  for (const _s of _voiced) { if (_dd.length && _s.text.trim().toLowerCase() === _dd[_dd.length - 1].text.trim().toLowerCase()) { log('  ⚠ дубль сцены (одинаковый текст подряд) — повтор пропущен'); continue; } _dd.push(_s); }
  _voiced = this._fit_scenes_to_target(_dd, this.reel_seconds || 0);
  const phrases = _voiced.map(s => s.text.trim());
  const spoken = []; this.reel_keep_stress = [];
  for (const _s of _voiced) { const [_m, _ch] = await this._merge_manual_stress(_s.text.trim(), _s.stress, _s.stress_manual); spoken.push(_m); this.reel_keep_stress.push(_ch); }
  if (!phrases.length) return { ok: false, msg: this._t('paste_reel_answer') };
  if (this.tts_engine === 'myvoice' && !(this.myvoice_path && vfs.exists(this.myvoice_path))) return { ok: false, msg: this._t('record_voice_first') };
  const images = {}, highlights = {}, scene_clips = {}, scene_picks = {}, scene_starts = {}; let n = 0;
  for (const s of _voiced) {
    if (!s.text.trim()) continue; n++;
    images[n] = s.query || 'cinematic atmospheric background';
    if (s.kw) highlights[n] = new Set(pysplit(s.kw).map(w => w.toUpperCase()));
    if (s.clip && vfs.exists(s.clip)) scene_clips[n] = s.clip;
    if (s.pick) scene_picks[n] = s.pick;
    if (s.start) scene_starts[n] = Number(s.start);
  }
  Object.assign(this, { reel_phrases: phrases, reel_spoken: spoken, reel_images: images, reel_highlights: highlights, reel_scene_clips: scene_clips, reel_scene_picks: scene_picks, reel_scene_starts: scene_starts, reel_sfx: {}, reel_text: phrases.join(' ') });
  if (['auto', 'mix', 'split'].includes(this.reel_media_source) && !(await this._has_stock())) {
    if (this.licensed) return { ok: false, code: 'need_media_key', msg: this._t('need_media_key') };
    return { ok: false, code: 'media_server', msg: this._t('media_key_server_down') };
  }
  let si = parseInt(style_index); if (Number.isNaN(si)) si = 0;
  this._build_reel_worker(si);
  return { ok: true, phrases: this.reel_phrases.length };
};

P._silence_mp3 = function (out, seconds) { vfs.write(out, A.wav(A.silence(Math.max(0.5, seconds), 44100, 2))); };
P._predict_reel_sec = function (phrases) { const WPS = this._wps(); const PAD = 0.35; return (phrases || []).reduce((a, p) => a + Math.max(1.2, pysplit(p || '').length / WPS) + PAD, 0); };
P._hard_max = function () { return Number(C['Api._HARD_MAX_SEC']); };
P._fit_scenes_to_target = function (voiced, target_sec) {
  const target = Number(target_sec || 0) || 0;
  if (voiced.length <= 2) return voiced;
  const WPS = this._wps(); const PAD = 0.35;
  const est = (s) => Math.max(1.2, pysplit(s.text || '').length / WPS) + PAD; const total = (l) => l.reduce((a, x) => a + est(x), 0);
  const hard = this._hard_max(); const cap = hard; const cur = [...voiced]; let dropped = 0;
  while (total(cur) > cap && cur.length > 2) {
    const cand = []; for (let i = 1; i < cur.length - 1; i++) if (!cur[i].cta && !cur[i].locked) cand.push(i);
    if (!cand.length) break;
    const mid = (cur.length - 1) / 2; const d = cand.reduce((a, b) => Math.abs(b - mid) < Math.abs(a - mid) ? b : a);
    cur.splice(d, 1); dropped++;
  }
  if (dropped) log(`  ✂ текст не влез даже в предельные ${hard.toFixed(0)}s — ужато на ${dropped} сред. сцен(ы), хук и финал сохранены, осталось ${cur.length} сцен ≈ ${total(cur).toFixed(0)}s`);
  else if (target > 0 && total(cur) > target * 1.15) log(`  ⏱ текст длиннее выбранных ${target.toFixed(0)}с (~${total(cur).toFixed(0)}с) — сцены сохранены целиком, ролик будет длиннее цели (потолок ${hard.toFixed(0)}с)`);
  return cur;
};
// _fit_to_target / _fit_myvoice -> параметры для движка {r, trimTo} (atempo + жёсткая обрезка)
P._fit_plan = function (actual, target) {
  const hard = this._hard_max();
  log(`  ⏱ ИТОГ до подгонки: ${actual.toFixed(1)}s │ цель ${Number(target || 0).toFixed(0)}s │ потолок ${hard.toFixed(0)}s`);
  if (actual <= hard + 0.3) {
    if (target > 0 && actual > target + 0.3) log(`  ✓ ${actual.toFixed(1)}s длиннее выбранных ${Number(target).toFixed(0)}s, но в пределах потолка ${hard.toFixed(0)}s — оставляю целиком, контент важнее цели`);
    else log(`  ✓ ${actual.toFixed(1)}s ≤ цели ${Number(target).toFixed(0)}s — длина = озвучка, не растягиваю (недобор = ролик короче цели, это норма)`);
    return { r: 1, trimTo: null };
  }
  const r = Math.min(1.25, actual / hard); const fin = actual / r;
  log(`  ⏩ перебор потолка: ускорил речь ×${r.toFixed(2)} → ${fin.toFixed(1)}s (потолок ${hard.toFixed(0)}s)`);
  if (fin > hard + 0.15) { const t = Math.max(0.5, hard - 0.05); log(`  ✂ ЖЁСТКО обрезал хвост до потолка → ${t.toFixed(1)}s ≤ ${hard.toFixed(0)}s (текст был длиннее — сократи для полного финала)`); return { r, trimTo: t }; }
  return { r, trimTo: null };
};
P._fit_myvoice_plan = function (d, target, hard_cap) {
  const MAX = 1.15; let tgt = Number(target || 0); if (tgt <= 0) tgt = hard_cap; let r = 1;
  if (d > tgt + 0.5) { r = Math.min(d / tgt, MAX); if (r > 1.001) { log(`  ⏩ «мой голос» ${d.toFixed(1)}s > цели ${tgt.toFixed(0)}s — мягко ускорил ×${r.toFixed(2)} → ${(d / r).toFixed(1)}s (сцены целы, не режу)`); d = d / r; } else r = 1; }
  let trimTo = null; if (d > hard_cap + 0.2) { trimTo = Math.max(0.5, hard_cap - 0.05); log(`  ✂️ «мой голос» ${d.toFixed(1)}s > потолка ${hard_cap.toFixed(0)}s — обрезано (сократи запись для полного финала)`); }
  return { r, trimTo };
};

P._tts_phrases = async function (phrases, voice = null, spoken = null) {
  while (true) {
    this._in_phrase_loop = true;
    try { const segs = await this._tts_phrases_once(phrases, voice, spoken); this._in_phrase_loop = false; return segs; }
    catch (rv) {
      this._in_phrase_loop = false;
      if (!(rv instanceof _RevoiceAll)) throw rv;
      if ((rv.engine || 'piper') === 'edge') log('  🔁 Платный голос сорвался → переозвучиваю ВЕСЬ ролик бесплатным Edge с нуля (единый голос, без склейки)');
      else log(`  🔁 Лимит Edge → переозвучиваю ВЕСЬ ролик голосом Piper «${rv.voice}» с нуля (единый голос, без склейки Edge+Piper)`);
      bar(8, 'Переозвучка одним голосом…');
    }
  }
};
P._tts_phrases_once = async function (phrases, voice = null, spoken = null) {
  const eng = (this.tts_engine === 'eleven' && this.licensed) ? 'Voice Key' : 'Edge-TTS';
  log(`  движок озвучки: ${eng}`);
  if (this.tts_engine === 'eleven' && this.eleven_key && this.licensed) {
    const need = phrases.reduce((a, p) => a + p.length, 0); const c = await this.get_eleven_credits(); const rem = c.ok ? c.remaining : null;
    log(`  Voice Key: остаток ${rem ?? '?'} символов. Нужно ~${need}.`);
    if (rem !== null && rem < need) log('  ⚠ кредитов может не хватить — следи за остатком');
  }
  const segs = [], bufs = []; let t = 0.0; const N = phrases.length; const _tgt = Number(this.reel_seconds || 0);
  if (N && _tgt) log(`  📐 План длины: цель ${_tgt.toFixed(0)}s, сцен ${N}, ~${(_tgt / N).toFixed(1)}s/сцену (реальная озвучка каждой ниже; итог подгонится под цель)`);
  await this._prewarm_pron(phrases);
  for (let i = 0; i < N; i++) {
    const ph = phrases[i]; const out = `temp/tts_${String(i).padStart(4, '0')}.mp3`; const lbl = `[${i + 1}/${N}]`;
    const say = (spoken && spoken[i]) ? spoken[i] : ph; const _ks = !!(this.reel_keep_stress && this.reel_keep_stress[i]);
    try { await this._synth_one(say, out, { emotion: null, label: lbl, keep_stress: _ks }); }
    catch (e) {
      if (e instanceof _RevoiceAll) throw e;
      const est = Math.max(1.5, Math.min(8.0, ph.length / 14.0));
      log(`  ⚠ ${lbl} озвучка не удалась (${String(e.message || e).slice(0, 50)}) → тишина ${est.toFixed(1)}s, сборка продолжается`);
      this._silence_mp3(out, est);
    }
    let b; try { b = await A.resample(await A.decode(out), 44100, 2); } catch (e) { b = A.silence(1.0, 44100, 2); }
    let d = b.duration; if (d <= 0) d = 1.0;
    segs.push({ start: t, end: t + d, text: ph }); t += d; bufs.push(b);
    bar(8 + Math.trunc((i + 1) / N * 22), 'Озвучка…');
    log(`  🎙 [${i + 1}/${N}] ${d.toFixed(1)}s — ${ph.slice(0, 48)}`);
  }
  const speech_t = t; let pad_added = 0.0; const TAIL_PAD = 0.3;
  if (segs.length && t > 0) { bufs.push(A.silence(TAIL_PAD, 44100, 2)); segs[segs.length - 1].end += TAIL_PAD; t += TAIL_PAD; pad_added = TAIL_PAD; }
  const _tgt2 = Number(this.reel_seconds || 0);
  if (_tgt2 > 0) { const delta = t - _tgt2; const verdict = delta > 1 ? 'перебор — ускорю/обрежу' : (delta < -1 ? 'недобор — ролик будет короче цели (норма)' : 'в цель'); log(`  📊 Бюджет длины: цель ${_tgt2.toFixed(0)}s │ речь ${speech_t.toFixed(1)}s (${N} сцен) │ тишина +${pad_added.toFixed(1)}s │ аудио-итог ${t.toFixed(1)}s │ Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s (${verdict}, коэф. ${(t / _tgt2).toFixed(2)})`); }
  this._voice_buf = A.concat(bufs, 44100, 2);
  if (this.tts_engine === 'eleven' && this.licensed) call_js('elevenCredits', await this.get_eleven_credits());
  return segs;
};

// клип сцены -> описание для движка (вместо rclip_i.mp4). False = заглушка
P._clip_spec = async function (srcPath, isVideo, frames, start, kb) {
  if (!srcPath || !vfs.exists(srcPath)) return null;
  if (!(await probeOk(srcPath, isVideo))) return null;
  return { kind: isVideo ? 'video' : 'image', blob: vfs.read(srcPath), frames, start: start || 0, kb };
};
P._download_pixabay = async function (query, tag) {
  const pexels_first = !!this.pexels_key;
  const _try_pixabay = async () => {
    const key = await this._active_pixabay_key(); if (!key) return [null, null, 'none'];
    const deg = (m) => this._degrade(m);
    let [src, isv, status] = await download_media(query, tag, key, this._reel_used_clips, this.reel_topic, deg);
    while (status === 'limit' && this._rotate_pixabay_key()) [src, isv, status] = await download_media(query, tag, await this._active_pixabay_key(), this._reel_used_clips, this.reel_topic, deg);
    return [src, isv, status];
  };
  if (pexels_first) {
    const [psrc, pvid] = await this._pexels_download(query, tag);
    if (psrc) { this._last_media_source = 'Pexels'; return [psrc, pvid]; }
    const [src, isv, status] = await _try_pixabay();
    if (src) { this._last_media_source = 'Pixabay'; log(`  🔁 Pexels пусто/лимит по «${query}» — клип взят с Pixabay`); return [src, isv]; }
    if (status === 'limit') log('  ⚠ Все Media-ключи исчерпаны (лимит Pixabay 429)');
    return [null, null];
  }
  const [src, isv, status] = await _try_pixabay();
  if ((!src || ['limit', 'empty'].includes(status)) && this.pexels_key) { const [psrc, pvid] = await this._pexels_download(query, tag); if (psrc) { this._last_media_source = 'Pexels'; return [psrc, pvid]; } }
  if (status === 'limit') { log('  ⚠ Все Media-ключи исчерпаны (лимит Pixabay 429)'); return [null, null]; }
  if (src) this._last_media_source = 'Pixabay';
  return [src, isv];
};
P._pexels_download = async function (query, tag) {
  if (!this.pexels_key) return [null, null];
  let clips; try { clips = await this._pexels_vids(query, 20); } catch (e) { return [null, null]; }
  for (const c of clips) {
    if (!c.url) continue; const dst = `temp/src_${tag}.mp4`;
    try { await _download(c.url, dst, 12); if (vfs.size(dst) > 0) { log(`  🎬 Pexels: клип для «${query}» → ${c.id}`); return [dst, true]; } } catch (e) { continue; }
  }
  return [null, null];
};
P._download_pick = async function (pick, tag) {
  const url = (pick || {}).url; if (!url) return [null, null];
  let isv = pick.is_video; if (isv === undefined || isv === null) isv = /\.(mp4|mov|webm|mkv)$/i.test(url.split('?')[0]);
  const dst = `temp/src_${tag}${isv ? '.mp4' : '.jpg'}`;
  try { await _download(url, dst, 10); } catch (e) { log(`  ⚠ клип сцены не скачался (${String(e.message || e).slice(0, 50)}) — беру авто-замену`); return [null, null]; }
  if (!(await probeOk(dst, !!isv))) { log('  ⚠ скачанный файл сцены не является медиа (битый/HTML) — беру авто-замену'); vfs.remove(dst); return [null, null]; }
  return [dst, !!isv];
};

P._build_reel_worker = async function (style_index) {
  this.busy = true; this._BUILD_DEGRADED = []; this._reset_key_rotation();
  this._reel_used_clips = new Set(); this._reel_prefetch = {};
  this._build_piper_override = null; this._build_eleven_override = false; this._edge_build_choice = null;
  _pix_reset_counters(); _build_log_open(); this._build_stage = 'старт';
  try {
    const style = STYLES[style_index % STYLES.length]; const phrases = this.reel_phrases;
    log(`▶ Рилс «${this.platform}», стиль: ${style.name}`);
    if (!phrases.length) throw new Error(this._t('reel_empty_text'));
    this._reset_scene_media(false);
    this._force_edge = false;
    if (this.tts_engine === 'eleven' && this.eleven_key && this.eleven_voice && this.licensed) {
      const needed = phrases.reduce((a, p) => a + p.length, 0) + 20; const c = await this.get_eleven_credits(); const rem = c.ok ? c.remaining : null;
      if (rem !== null && rem < needed) { this._force_edge = true; log('  ⚠ Voice Key исчерпан до обновления лимита — озвучиваю бесплатным Edge-TTS'); }
      else { const em = EMOTIONS[this.reel_emotion] || EMOTIONS.energetic; log(`  🎙 Voice Key: подача «${em.ru}» (stability=${em.stability}, style=${em.style})`); }
    }
    this._build_stage = 'озвучка';
    let segs, audio_total;
    if (this.tts_engine === 'myvoice') {
      log('▶ Источник звука: МОЙ ГОЛОС (запись)'); log('▶ Тайминги субтитров из РЕАЛЬНОЙ речи (Whisper word-level)…');
      const words = await this._transcribe_words(this.myvoice_path);
      const vb = await A.resample(await A.decode(this.myvoice_path), 44100, 2); const rec_dur = vb.duration;
      segs = this._align_myvoice(phrases, words, rec_dur); audio_total = rec_dur; this._voice_buf = vb;
    } else {
      log('▶ Озвучиваю текст рилса…');
      segs = await this._tts_phrases(phrases, this._active_edge_voice(), this.reel_spoken);
      audio_total = segs.length ? segs[segs.length - 1].end : 0.0;
    }
    this.reel_segments = segs;
    log(`▶ Фраз: ${segs.length}  (аудио ${segs[segs.length - 1].end.toFixed(1)}s)`);
    // 2) клипы под каждую фразу
    const clip_h = 1920; const clips = []; const placeholders = []; const n = segs.length;
    for (const _p of Object.values(this.reel_scene_picks || {})) if (_p && _p.id != null) this._reel_used_clips.add(_p.id);
    this._build_stage = 'клипы';
    for (let i = 0; i < n; i++) {
      const seg = segs[i]; const start = seg.start;
      let dur = i < n - 1 ? segs[i + 1].start - start : (audio_total - start + 0.20);
      if (dur <= 0.1) dur = 0.5; if (i === 0) dur = Math.max(dur, 2.5);
      const frames = Math.max(1, Math.round(dur * 30));
      let use_file = this.reel_scene_clips[i + 1] || null;
      const cstart = Number(this.reel_scene_starts[i + 1] || 0) || 0;
      let spec = null, _scene_ph = false;
      if (use_file && vfs.exists(use_file)) {
        log(`[${i + 1}/${n}] свой файл: ${path.basename(use_file)} (${dur.toFixed(1)}s` + (cstart ? `, с ${cstart.toFixed(0)}с` : '') + ')' + (i === 0 ? ' — ХУК' : ''));
        spec = await this._clip_spec(use_file, this._is_video_file(use_file), frames, cstart, 0);   // свой файл: зум по центру (_make_clip_local)
        if (spec && spec.kind === 'image') spec.kbLocal = true;
      }
      if (!spec) {
        const query = this.reel_images[i + 1] || 'background'; const phr = phrases[i] || '';
        const pick = this.reel_scene_picks[i + 1];
        let psrc = null, pisv = null;
        if (pick && pick.url) [psrc, pisv] = await this._download_pick(pick, `r${i}`);
        try {
          if (psrc) {
            const _psrc_name = { pexels: 'Pexels', pixabay: 'Pixabay' }[(pick || {}).source] || 'превью';
            log(`[${i + 1}/${n}] сцена «${phr.slice(0, 40)}» → запрос «${query}» → клип id ${pick ? pick.id : '—'}  (${dur.toFixed(1)}s` + (cstart ? `, с ${cstart.toFixed(0)}с` : '') + ')' + (i === 0 ? ' — ХУК' : ''));
            log(`  🎬 сцена ${i + 1}: клип от ${_psrc_name} по запросу «${query}»`);
            spec = await this._clip_spec(psrc, pisv, frames, cstart, i);
          } else {
            log(`[${i + 1}/${n}] сцена «${phr.slice(0, 44)}» → запрос «${query}»  (${dur.toFixed(1)}s)` + (i === 0 ? ' — ХУК' : ''));
            this._last_media_source = '?';
            const [src, isv] = await this._download_pixabay(query, `r${i}`);
            spec = src ? await this._clip_spec(src, isv, frames, cstart, i) : null;
            log(`  🎬 сцена ${i + 1}: клип от ${this._last_media_source || '?'} по запросу «${query}»`);
          }
          if (!spec) { log(`  ✖ сцена r${i}: клип НЕ собрался — подставляю тёмную заглушку (сцену стоит заменить вручную)`); spec = { kind: 'color', color: '#1a1230', frames }; _scene_ph = true; }
        } catch (e) { log(`  ⚠ сцена ${i + 1}: клип не собрался (${String(e.message || e).slice(0, 60)}) → запасной кадр`); spec = { kind: 'color', color: '#141018', frames }; _scene_ph = true; }
        if (_scene_ph) placeholders.push(i + 1);
      }
      clips.push(spec);
      bar(30 + Math.trunc((i + 1) / n * 35), 'Клипы…');
    }
    log(`▶ Pixabay: search=${PIX.COUNT}, download=${PIX.DL}, всего=${PIX.COUNT + PIX.DL} на ${n} сцен (≈${(PIX.COUNT / Math.max(1, n)).toFixed(1)} search/сцена; цель ≤2/сцена)`);
    if (PIX.LIMIT_HIT) {
      if (this.pexels_key) { log('  🔁 лимит Pixabay (429) — клипы взяты с Pexels, сборка не остановлена'); call_js('reelLimit', this._t('pix_switch_pexels')); }
      else { log('  ⛔ лимит фотостока (429) был исчерпан — часть клипов заменена запасными кадрами'); call_js('reelLimit', this._t('pix_limit_note')); }
    }
    this._build_stage = 'склейка клипов'; log('▶ Склеиваю клипы рилса…');
    bar(68, 'Голос…');
    this._build_stage = 'сведение звука';
    const vlen = segs[segs.length - 1].end; const music = this._pick_music(vlen);
    let musicSpec = null;
    if (music) { try { musicSpec = { buf: await A.resample(await A.decode(music), 44100, 2), db: this.music_db }; log(`▶ Музыка «${path.basename(music)}» (${this.music_db}dB)`); } catch (e) { log(`  ⚠ музыка не декодировалась: ${String(e.message || e).slice(0, 60)}`); } }
    else if (this.music_track) log('ℹ Музыки нет (assets/music/ пуста) — собираю без неё');
    if (!this.sfx_enabled) log('  звуковые эффекты выключены');
    // 4) субтитры
    this._build_stage = 'субтитры';
    let ass = null;
    if (this.no_subs) { log('▶ «Без субтитров» включено — собираю рилс без текста субтитров'); bar(80, 'Без субтитров…'); }
    else {
      bar(74, 'Субтитры…'); log('▶ Выжигаю крупные субтитры…');
      const rstyle = Object.assign({}, style);
      rstyle.size = Math.max(40, Math.trunc(1920 * this.sub_fontpct)); rstyle.outline = Math.max(8, style.outline); rstyle.shadow = Math.max(3, style.shadow);
      const [al, mv] = this._sub_align_marginv(1920, rstyle.size); rstyle.align = al; rstyle.marginv = mv; rstyle.marginl = 100; rstyle.marginr = 100;
      ass = build_ass('temp/reel_subs.ass', segs, rstyle, 1080, 1920, this.reel_highlights, null, null, 2, true);
    }
    const title = (this.title_on && this.title_text && this.title_text.trim()) ? { text: this.title_text, xpct: this.title_xpct, ypct: this.title_ypct, fontpct: this.title_fontpct, theme: (this.title_theme in C.TITLE_THEMES) ? this.title_theme : 'T1', split: false } : null;
    if (title) log('▶ Наложил постоянный заголовок');
    bar(84, 'Концовка…');
    // 5) подгонка длины + финальный кадр
    this._build_stage = 'финализация';
    const videoLen = clips.reduce((a, c) => a + c.frames, 0) / 30; const contentLen = Math.min(videoLen, this._voice_buf.duration);
    const fit = this.tts_engine === 'myvoice' ? this._fit_myvoice_plan(contentLen, this.reel_seconds, 40.0) : this._fit_plan(contentLen, this._target_sec());
    const outro = await this._outro_spec();
    const tm = strftime('%H%M%S'); let out_name = `rils_${tm}.mp4`;
    bar(86, 'Рендер видео…');
    log('▶ Рендер ролика (кодирование видео в браузере)…');
    const t0 = now();
    const res = await renderReel({ W: 1080, H: clip_h, clips, voice: this._voice_buf, music: musicSpec, ass, title, fit, outro,
      metaTitle: 'VideoRils Mini ' + APP_VERSION, onProgress: (f) => bar(86 + Math.trunc(f * 12), `Рендер ${Math.trunc(f * 100)}%…`) });
    if (res.ext !== '.mp4') out_name = out_name.replace('.mp4', res.ext);
    const out_path = `output/${out_name}`;
    vfs.write(out_path, res.blob); await vfs.flush(out_path);
    log(`  🎞 рендер: ${res.duration.toFixed(1)}s видео за ${(now() - t0).toFixed(1)}с, ${(res.blob.size / 1048576).toFixed(1)} МБ`);
    log('  🧹 метаданные вычищены, записаны свои (свежий creation_time)');
    this.last_reel = out_path;
    if (!this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    log(`✅ Рилс готов${this.no_subs ? ' (без субтитров)' : ''}: ${out_name}`);
    this._ping_render();
    const _bad_total = placeholders.length;
    if (placeholders.length) log('⚠ Сцены без медиа (тёмная заглушка): ' + placeholders.map(x => '#' + x).join(', '));
    if (_bad_total) this._degrade(`${_bad_total} сцен(а) не собрались — заменены тёмной заглушкой. Проверь ролик`);
    bar(100, 'Готово');
    this.track('reel_done');
    call_js('reelDone', out_path, '', _bad_total);
    return out_path;
  } catch (e) {
    const stage = this._build_stage || '?';
    log(`✖ Сборка прервана на шаге «${stage}»: ${e.message || e}`);
    try { this.report_client_error('reel_build_failed', `${e.name || 'Error'}: ${e.message || e}`, stage); } catch (e2) { }
    this.track('generate_failed', String(e.message || e).slice(0, 120));
    call_js('reelDone', '', String(e.message || e).slice(0, 200));
    return null;
  } finally { this.busy = false; this._reel_used_clips = null; this._reel_prefetch = {}; _build_log_close(); }
};

// Финальный кадр (_append_outro_if_on/_make_outro_clip) -> спецификация для движка
P._outro_spec = async function () {
  const photo_ok = this.outro_bg === 'photo' && this.outro_photo && (vfs.exists(this.outro_photo) || await vfs.restore(this.outro_photo));
  const has_cta = (this.outro_text || '').trim() || (this.outro_tg || '').trim() || (this.outro_site || '').trim() || photo_ok;
  if (!(this.outro_on && has_cta)) return null;
  try {
    log('▶ Добавляю финальный кадр-призыв (CTA + QR)…');
    let dur = Math.max(3, Math.min(6, parseInt(this.outro_seconds || 3) || 3));
    let voiceBuf = null;
    if (this.outro_voice && (this.outro_text || '').trim()) {
      try {
        const vp = 'temp/outro_voice.mp3';
        const [_say, _ks] = await this._merge_manual_stress(this.outro_text.trim(), this.outro_stress_text || '', this.outro_stress_manual || null);
        await this._synth_one(_say, vp, { keep_stress: _ks });
        voiceBuf = await A.resample(await A.decode(vp), 44100, 2);
        if (voiceBuf.duration > 0) dur = Math.max(dur, voiceBuf.duration + 0.6); else voiceBuf = null;
      } catch (e) { log(`  ⚠ озвучка призыва не вышла: ${e.message || e}`); voiceBuf = null; }
    }
    const music = this._pick_music(dur); let mbuf = null;
    if (music) { try { mbuf = await A.resample(await A.decode(music), 44100, 2); } catch (e) { mbuf = null; } }
    let audio;
    try { audio = await outroAudio(dur, voiceBuf, mbuf, this.music_db); } catch (e) { log(`  ⚠ звук финала не свёлся (${e.message || e}) — ставлю тишину`); audio = A.silence(dur, 44100, 2); }
    const self = this;
    return { dur, audio, makeCanvas: async (lastFrame) => await self._render_outro_png('temp/outro.png', self.outro_bg === 'blur' ? lastFrame : null) };
  } catch (e) { log(`  ⚠ финальный кадр не добавился (${e.message || e}) — собираю без него`); return null; }
};

// ---------- результат ----------
function downloadBlob(b, name) { const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
P.open_reel = function () { if (this.last_reel && vfs.exists(this.last_reel)) { window.open(vfs.objectUrl(this.last_reel), '_blank'); return true; } return false; };
P.open_video = P.open_reel;
// «Галерея» = папка output -> в браузере это «Скачать ролик»
P.open_folder = function () { if (this.last_reel && vfs.exists(this.last_reel)) { downloadBlob(vfs.read(this.last_reel), path.basename(this.last_reel)); return true; } return false; };
P.clear_reel_preview = function () { this._reel_master_path = ''; this.last_reel = ''; return { ok: true }; };
// готовый ролик в плеер — ПРЯМОЙ blob-ссылкой из памяти: без SW и хранилища браузера
// (у части браузеров видео через SW не грузилось — плеер 0:00). Прошлую ссылку освобождаем.
function _blobUrlOf(api, src) {
  const b = vfs.read(src); if (!b) return '';
  try { if (api._preview_blob_url) URL.revokeObjectURL(api._preview_blob_url); } catch (e) { }
  api._preview_blob_url = URL.createObjectURL(b.type ? b : new Blob([b], { type: mimeOf(src) }));
  return api._preview_blob_url;
}
P.get_reel_preview_url = async function () {
  const src = this.last_reel || ''; if (!src || !vfs.exists(src)) return { ok: false };
  const url = _blobUrlOf(this, src); if (!url) return { ok: false };
  return { ok: true, url };
};
P.extract_audio = async function () {
  const src = this.last_reel || ''; if (!src || !vfs.exists(src)) return { ok: false, msg: this._t('extract_no_reel') };
  try {
    const buf = await A.decode(src); const name = path.splitext(path.basename(src))[0] + '_audio.wav';
    const out = 'output/' + name; vfs.write(out, A.wav(buf)); downloadBlob(vfs.read(out), name);
    log(`🎵 Звук сохранён: ${name}`);
    return { ok: true, path: out, name };
  } catch (e) { log(`  ⚠ извлечение звука не удалось: ${String(e.message || e).slice(0, 60)}`); return { ok: false, msg: this._t('extract_fail') }; }
};
P.ffmpeg_ok = function () { return { ok: typeof VideoEncoder !== 'undefined' }; };
