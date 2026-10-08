// Порт Api: build_reel, озвучка фраз, _build_reel_worker, подгонка длины, финальный кадр,
// результат/просмотр (app.py 11037–12204, 12749–12900).
import { C, log, re, vfs, path, call_js, bar, now, strftime, sleep, _build_log_open, _build_log_close, choice, pysplit, APP_VERSION } from './core.js';
import { build_ass, align_sub_words, clean_phrase } from './textutil.js';
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

P._has_stock = function () { return !!(this.pixabay_keys.length || this.pexels_key); };

P.build_reel = async function (claude_answer, style_index) {
  this.track('generate_started');
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
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
  const images = {}, highlights = {}, scene_clips = {}, scene_picks = {}, scene_starts = {}, scene_ends = {}; let n = 0;
  for (const s of _voiced) {
    if (!s.text.trim()) continue; n++;
    images[n] = s.query || 'cinematic atmospheric background';
    if (s.kw) highlights[n] = new Set(pysplit(s.kw).map(w => w.toUpperCase()));
    if (s.clip && vfs.exists(s.clip)) scene_clips[n] = s.clip;
    if (s.pick) scene_picks[n] = s.pick;
    if (s.start) scene_starts[n] = Number(s.start);
    if (s.end_at) scene_ends[n] = Number(s.end_at);
  }
  Object.assign(this, { reel_phrases: phrases, reel_spoken: spoken, reel_images: images, reel_highlights: highlights, reel_scene_clips: scene_clips,
    reel_scene_picks: scene_picks, reel_scene_starts: scene_starts, reel_scene_ends: scene_ends, reel_sfx: {}, reel_text: phrases.join(' ') });
  this.reel_scene_lens = _voiced.map(s => Number(s.manual_len || 0) || 0);
  this._has_manual_lens = this.reel_scene_lens.some(x => x > 0);
  if (['auto', 'mix', 'split'].includes(this.reel_media_source) && !this._has_stock()) return { ok: false, msg: this._t('stock_key_needed_mine') };
  if (this.reel_media_source === 'split' && !(this.split_top_path && vfs.exists(this.split_top_path))) return { ok: false, msg: this._t('split_need_top') };
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
  const hard = this._hard_max(); const cur = [...voiced]; let dropped = 0;
  while (total(cur) > hard && cur.length > 2) {
    const cand = []; for (let i = 1; i < cur.length - 1; i++) if (!cur[i].cta && !cur[i].locked) cand.push(i);
    if (!cand.length) break;
    const mid = (cur.length - 1) / 2; const d = cand.reduce((a, b) => Math.abs(b - mid) < Math.abs(a - mid) ? b : a);
    cur.splice(d, 1); dropped++;
  }
  if (dropped) this._degrade(`Текст не влезает даже в предельные ${hard.toFixed(0)}с — убрано ${dropped} средних сцен(ы) (хук и финал сохранены, осталось ${cur.length}); сократи текст, чтобы сохранить все сцены`);
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
  if (r >= 1.2) this._degrade(`Текст длиннее предельных ${hard.toFixed(0)}с — речь ускорена ×${r.toFixed(2)} (звучит быстрее обычного; сократи текст для естественного темпа)`);
  if (fin > hard + 0.15) { this._degrade(`Текст не уместился даже в предельные ${hard.toFixed(0)}с — хвост обрезан (финальная фраза может оборваться; сократи текст)`); return { r, trimTo: Math.max(0.5, hard - 0.05) }; }
  return { r, trimTo: null };
};
// ручные длины сцен («Своя сборка»): без ускорения, только жёсткий потолок 120с
P._hard_trim_plan = function (actual, cap) { if (actual > cap + 0.5) { log(`  ✂️ длина превысила ${cap.toFixed(0)}с — обрезано до жёсткого потолка`); return { r: 1, trimTo: Math.max(0.5, cap - 0.05) }; } return { r: 1, trimTo: null }; };
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
  const eng = this.tts_engine === 'eleven' ? 'Voice Key' : 'Edge-TTS';
  log(`  движок озвучки: ${eng}`);
  if (this.tts_engine === 'eleven' && this.eleven_key) {
    const need = phrases.reduce((a, p) => a + p.length, 0); const c = await this.get_eleven_credits(); const rem = c.ok ? c.remaining : null;
    log(`  Voice Key: остаток ${rem ?? '?'} символов. Нужно ~${need}.`);
    if (rem !== null && rem < need) log('  ⚠ кредитов может не хватить — следи за остатком');
  }
  const segs = [], bufs = []; let t = 0.0; const N = phrases.length; const _tgt = Number(this.reel_seconds || 0);
  if (N && _tgt) log(`  📐 План длины: цель ${_tgt.toFixed(0)}s, сцен ${N}, ~${(_tgt / N).toFixed(1)}s/сцену (реальная озвучка каждой ниже; итог подгонится под цель)`);
  for (let i = 0; i < N; i++) {
    const ph = phrases[i]; const out = `temp/tts_${String(i).padStart(4, '0')}.mp3`;
    const say = (spoken && spoken[i]) ? spoken[i] : ph; const _ks = !!(this.reel_keep_stress && this.reel_keep_stress[i]);
    try { await this._synth_one(say, out, { keep_stress: _ks }); }
    catch (e) {
      if (e instanceof _RevoiceAll) throw e;
      const est = Math.max(1.5, Math.min(8.0, ph.length / 14.0));
      log(`  ⚠ [${i + 1}/${N}] озвучка не удалась (${String(e.message || e).slice(0, 50)}) → тишина ${est.toFixed(1)}s, сборка продолжается`);
      this._silence_mp3(out, est);
    }
    let b; try { b = await A.resample(await A.decode(out), 44100, 2); } catch (e) { b = A.silence(1.0, 44100, 2); }
    let d = b.duration; if (d <= 0) d = 1.0;
    // ручная длина сцены («Своя сборка»): добиваем тишиной до заданной (apad whole_dur)
    const ml = Number((this.reel_scene_lens || [])[i] || 0) || 0;
    if (ml > 0 && ml > d + 0.05) { b = A.concat([b, A.silence(ml - d, 44100, 2)], 44100, 2); log(`     ⏱ ручная длина сцены ${i + 1}: ${d.toFixed(1)}s → ${ml.toFixed(1)}s`); d = ml; }
    segs.push({ start: t, end: t + d, text: ph }); t += d; bufs.push(b);
    bar(8 + Math.trunc((i + 1) / N * 22), 'Озвучка…');
    log(`  🎙 [${i + 1}/${N}] ${d.toFixed(1)}s — ${ph.slice(0, 48)}`);
  }
  const speech_t = t; let pad_added = 0.0; const TAIL_PAD = 0.3;
  if (segs.length && t > 0) { bufs.push(A.silence(TAIL_PAD, 44100, 2)); segs[segs.length - 1].end += TAIL_PAD; t += TAIL_PAD; pad_added = TAIL_PAD; }
  const _tgt2 = Number(this.reel_seconds || 0);
  if (_tgt2 > 0) { const delta = t - _tgt2; const verdict = delta > 1 ? 'перебор — ускорю/обрежу' : (delta < -1 ? 'недобор — ролик будет короче цели (норма)' : 'в цель'); log(`  📊 Бюджет длины: цель ${_tgt2.toFixed(0)}s │ речь ${speech_t.toFixed(1)}s (${N} сцен) │ тишина +${pad_added.toFixed(1)}s │ аудио-итог ${t.toFixed(1)}s │ Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s (${verdict}, коэф. ${(t / _tgt2).toFixed(2)})`); }
  this._voice_buf = A.concat(bufs, 44100, 2);
  if (this.tts_engine === 'eleven') call_js('elevenCredits', await this.get_eleven_credits());
  return segs;
};

// клип сцены -> описание для движка (вместо rclip_i.mp4). null = заглушка
P._clip_spec = async function (srcPath, isVideo, frames, start, kb, extra = {}) {
  if (!srcPath || !vfs.exists(srcPath)) return null;
  if (!(await probeOk(srcPath, isVideo))) return null;
  return Object.assign({ kind: isVideo ? 'video' : 'image', blob: vfs.read(srcPath), frames, start: start || 0, kb }, extra);
};
P._download_pixabay = async function (query, tag) {
  const keys = this.pixabay_keys; const pexels_first = !!this.pexels_key;
  const deg = (m) => this._degrade(m);
  const _try_pixabay = async () => {
    if (!keys.length) return [null, null];
    const n = keys.length;
    for (let off = 0; off < n; off++) {
      const idx = (this.pixabay_idx + off) % n;
      const [src, isv, status] = await download_media(query, tag, keys[idx], this._reel_used_clips, this.reel_topic, deg);
      if (status === 'limit') { log(`  ⚠ Media Key #${idx + 1} исчерпан, пробую следующий`); continue; }
      this.pixabay_idx = idx;
      if (src) return [src, isv];
    }
    return [null, null];
  };
  if (pexels_first) {
    const [psrc, pvid] = await this._pexels_download(query, tag);
    if (psrc) { this._last_media_source = 'Pexels'; return [psrc, pvid]; }
    const [src, isv] = await _try_pixabay();
    if (src) { this._last_media_source = 'Pixabay'; log(`  🔁 Pexels пусто/лимит по «${query}» — клип взят с Pixabay`); return [src, isv]; }
    return [null, null];
  }
  const [src, isv] = await _try_pixabay();
  if (src) { this._last_media_source = 'Pixabay'; return [src, isv]; }
  if (!keys.length && !this.pexels_key) return [null, null];
  if (this.pexels_key) { const [psrc, pvid] = await this._pexels_download(query, tag); if (psrc) { this._last_media_source = 'Pexels'; log('  🔁 лимит Pixabay (429) — клип взят с Pexels, без остановки'); return [psrc, pvid]; } }
  return [null, null];
};
// первый пригодный кадр с Pexels: ВИДЕО, если нет — ФОТО (тот же ключ); дедуп по used
P._pexels_download = async function (query, tag) {
  if (!this.pexels_key) return [null, null];
  const used = this._reel_used_clips;
  for (const c of await this._pexels_call('pexels_videos', query, 20)) {
    if (!c.url || (used && used.has(c.id))) continue;
    const dst = `temp/src_${tag}.mp4`;
    try { await _download(c.url, dst); if (vfs.size(dst) > 0) { if (used) used.add(c.id); log(`  🎬 Pexels: видео для «${query}» → ${c.id}`); return [dst, true]; } } catch (e) { continue; }
  }
  for (const p of await this._pexels_call('pexels_photos', query, 20)) {
    if (!p.url || (used && used.has(p.id))) continue;
    const dst = `temp/src_${tag}.jpg`;
    try { await _download(p.url, dst); if (vfs.size(dst) > 0) { if (used) used.add(p.id); log(`  🖼 Pexels: фото для «${query}» → ${p.id}`); return [dst, false]; } } catch (e) { continue; }
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
// лёгкая цветокоррекция ±3-5% — ОДИН набор на ролик
P._gen_uniq = function () { const u = (a) => (Math.random() * 2 - 1) * a; return { b: u(0.04), c: 1.0 + u(0.04), s: 1.0 + u(0.05) }; };
// _foreign_uniq_vf -> пост-обработка кадра движка: зона затирки (до hflip) + зеркало + eq
P._foreign_post = function () {
  const post = {};
  const z = this._effective_cap_zone();
  if (z) { const [zx, zy, zw, zh] = Api._cap_zone_px(z); post.zone = { x: zx, y: zy, w: zw, h: zh, color: this.foreign_cap_color || '#000000' }; }
  if (this.foreign_mirror) post.mirror = true;
  if (this.foreign_color ?? true) { const u = this._reel_uniq || this._gen_uniq(); this._reel_uniq = u; post.eq = u; }
  return post;
};
P._foreign_uniq_desc = function () {
  const p = []; if (this.foreign_hide_caps) p.push('зум 92%'); const z = this._effective_cap_zone(); if (z) p.push('затирка зоны'); if (this.foreign_mirror) p.push('зеркало');
  if (this.foreign_color ?? true) { const u = this._reel_uniq || {}; p.push(`eq b=${(u.b || 0).toFixed(3)} c=${(u.c || 1).toFixed(3)} s=${(u.s || 1).toFixed(3)}`); }
  return p.join(', ');
};

P._build_reel_worker = async function (style_index, batch = false, out_name = null) {
  this._BUILD_DEGRADED = []; _pix_reset_counters();
  this._reset_key_rotation();
  if (batch) this._has_manual_lens = false;
  if (!batch) { this.busy = true; this._reel_used_clips = new Set(); _build_log_open(); }
  this._build_stage = 'старт';
  try {
    const style = STYLES[style_index % STYLES.length]; const phrases = this.reel_phrases;
    log(`▶ Рилс «${this.platform}», стиль: ${style.name}`);
    if (!phrases.length) throw new Error(this._t('reel_empty_text'));
    this._reset_scene_media(false);
    if (!batch) { this._build_piper_override = null; this._build_eleven_override = false; this._edge_build_choice = null; }
    this._force_edge = false;
    if (this.tts_engine === 'eleven' && this.eleven_keys.length && this.eleven_voice) {
      const needed = phrases.reduce((a, p) => a + p.length, 0) + 20;
      const [ok] = await this._el_prepare_key(needed);
      if (ok) { const em = EMOTIONS[this.reel_emotion] || EMOTIONS.energetic; log(`  🎙 Voice Key #${this.eleven_idx + 1}: хватает на весь рилс (~${needed} симв.); подача «${em.ru}» (stability=${em.stability}, style=${em.style})`); await this._prewarm_pron(phrases); }
      else { this._force_edge = true; this._degrade('Премиум Voice Key закончился — ролик озвучен запасным бесплатным голосом Edge (не твой платный голос)'); }
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
    const src_mode = this.reel_media_source; const media = this.reel_media || [];
    if (src_mode !== 'auto' && media.length) log(`▶ Видеоряд: «${src_mode}», своих файлов: ${media.length}`);
    const split = src_mode === 'split';
    const clips = []; const placeholders = []; const n = segs.length;
    this._build_stage = 'клипы';
    // «Кадры из этого видео»: видеоряд — сам исходник (позиция сцены пропорционально озвучке)
    let _src_frames = false, _src_dur = 0.0, _src_usable = 0.0;
    if (!split && this.reel_source === 'foreign' && (this.foreign_visual ?? 'source') === 'source' && this.foreign_audio_path && vfs.exists(this.foreign_audio_path) && this._is_video_file(this.foreign_audio_path)) {
      const { mediaDur, detectOutro } = await import('./frames.js');
      _src_dur = (await mediaDur(this.foreign_audio_path)) || 0.0;
      if (_src_dur > 1.5) {
        let _tail = Number(this.foreign_tail_trim || 3);
        let _outro = await detectOutro(this.foreign_audio_path, _src_dur);
        if (_outro > 0) log(`  ✂ обнаружена концовка ${_outro.toFixed(1)}с — отрезана автоматически`);
        _src_usable = Math.max(1.0, _src_dur - _outro - _tail);
        const _min_need = Math.min(_src_dur * 0.5, Math.max(3.0, audio_total * 0.5));
        if (_src_usable < _min_need) {
          let _over = _min_need - _src_usable; const _cut = Math.min(_tail, _over); _tail -= _cut; _over -= _cut;
          if (_over > 0.1) _outro = Math.max(0.0, _outro - _over);
          _src_usable = Math.max(1.0, _src_dur - _outro - _tail);
          log(`  ⚠ после обрезок мало видео — запас ужат (конец ${_tail.toFixed(0)}с, аутро ${_outro.toFixed(1)}с)`);
        }
        _src_frames = true;
        this._reel_uniq = this._gen_uniq();
        const _uv = this._foreign_uniq_desc();
        log(`🎥 Видеоряд из ИСХОДНИКА: длина ${_src_dur.toFixed(0)}с, обрезка конца ${_tail.toFixed(0)}с + аутро ${_outro.toFixed(1)}с → полезно ${_src_usable.toFixed(0)}с` + (_uv ? `; уникализация [${_uv}]` : ''));
        if (this.foreign_hide_caps) log('  🙈 Скрытие чужих надписей: зум ~8% (снимает угловые вотермарки/лого). Наши субтитры идут снизу поверх зоны чужих титров — при стиле БЕЗ непрозрачной подложки чужой текст может просвечивать (возьми стиль с плашкой).');
        if (audio_total > _src_usable + 1) log(`  ⚠ озвучка (${audio_total.toFixed(0)}с) длиннее исходника (${_src_usable.toFixed(0)}с) — сегменты зациклят кадры исходника`);
      }
    }
    if (!this._reel_used_clips) this._reel_used_clips = new Set();
    for (const _p of Object.values(this.reel_scene_picks || {})) if (_p && _p.id != null) this._reel_used_clips.add(_p.id);
    const _blurLocal = (this.foreign_fit || 'blur') === 'blur' && !this.foreign_hide_caps;
    for (let i = 0; i < n; i++) {
      const seg = segs[i]; const start = seg.start;
      let dur = i < n - 1 ? segs[i + 1].start - start : (audio_total - start + 0.20);
      if (dur <= 0.1) dur = 0.5; if (i === 0) dur = Math.max(dur, 2.5);
      const frames = Math.max(1, Math.round(dur * 30));
      let use_file = null, _mom = 0.0, extra = {};
      if (_src_frames) {
        _mom = _src_usable * (start / Math.max(0.1, audio_total));
        _mom = Math.max(0.0, Math.min(_mom, Math.max(0.0, _src_dur - 0.6)));
        use_file = this.foreign_audio_path;
        extra = { post: this._foreign_post() };
        log(`[${i + 1}/${n}] кадр исходника с ${_mom.toFixed(1)}с (${dur.toFixed(1)}s)` + (i === 0 ? ' — ХУК' : ''));
      } else if (!split && this.reel_scene_clips[i + 1]) use_file = this.reel_scene_clips[i + 1];
      else if (!split && ['mine', 'mix'].includes(src_mode) && i < media.length) use_file = media[i];
      else if (!split && src_mode === 'mine' && media.length) use_file = media[media.length - 1];
      let cstart, cend;
      if (_src_frames) { cstart = _mom; cend = 0; }
      else { cstart = Number(this.reel_scene_starts[i + 1] || 0) || 0; cend = Number((this.reel_scene_ends || {})[i + 1] || 0) || 0; }
      let spec = null, _scene_ph = false;
      if (use_file && vfs.exists(use_file)) {
        log(`[${i + 1}/${n}] свой файл: ${path.basename(use_file)} (${dur.toFixed(1)}s` + (cstart ? `, с ${cstart.toFixed(0)}с` : '') + (cend ? `–${cend.toFixed(0)}с` : '') + ')' + (i === 0 ? ' — ХУК' : ''));
        const isv = this._is_video_file(use_file);
        // _make_clip_local: видео — blur-letterbox (fit=blur) или кроп (+зум 92% под «Скрыть надписи»); фото — зум по центру
        const fit = isv ? { blur: _blurLocal, zoom: _src_frames && !!this.foreign_hide_caps } : null;
        spec = await this._clip_spec(use_file, isv, frames, cstart, 0, Object.assign({ end: cend, fit }, extra));
        if (!spec) log('  ⚠ свой файл не лёг, fallback');
      }
      if (!spec) {
        const query = this.reel_images[i + 1] || 'background'; const phr = phrases[i] || '';
        const pick = !split ? this.reel_scene_picks[i + 1] : null;
        let psrc = null, pisv = null;
        if (pick && pick.url) [psrc, pisv] = await this._download_pick(pick, `r${i}`);
        // _make_clip: blur только в режиме кадров исходника; иначе центр-кроп
        const sfit = (this._foreign_src_frames_active() && _blurLocal) ? { blur: true, zoom: false } : null;
        try {
          if (psrc) {
            const _psrc_name = { pexels: 'Pexels', pixabay: 'Pixabay' }[(pick || {}).source] || 'превью';
            log(`[${i + 1}/${n}] сцена «${phr.slice(0, 40)}» → запрос «${query}» → клип превью id ${pick.id}  (${dur.toFixed(1)}s` + (cstart ? `, с ${cstart.toFixed(0)}с` : '') + ')' + (i === 0 ? ' — ХУК' : ''));
            log(`  🎬 сцена ${i + 1}: клип от ${_psrc_name} по запросу «${query}»`);
            spec = await this._clip_spec(psrc, pisv, frames, cstart, i, { end: cend, fit: pisv ? sfit : null });
          } else {
            log(`[${i + 1}/${n}] сцена «${phr.slice(0, 44)}» → запрос «${query}»  (${dur.toFixed(1)}s)` + (i === 0 ? ' — ХУК' : ''));
            this._last_media_source = '?';
            const [src, isv] = await this._download_pixabay(query, `r${i}`);
            spec = src ? await this._clip_spec(src, isv, frames, cstart, i, { end: cend, fit: isv ? sfit : null }) : null;
            log(`  🎬 сцена ${i + 1}: клип от ${this._last_media_source || '?'} по запросу «${query}»`);
          }
          if (!spec) { log(`  ✖ сцена ${i + 1}: клип НЕ собрался — подставляю тёмную заглушку (сцену стоит заменить вручную)`); spec = { kind: 'color', color: '#1a1230', frames }; _scene_ph = true; }
        } catch (e) { log(`  ✖ сцена ${i + 1}: клип НЕ собрался (${String(e.message || e).slice(0, 80)}) — подставляю тёмную заглушку (сцену стоит заменить вручную)`); spec = { kind: 'color', color: '#1a1230', frames }; _scene_ph = true; }
        if (_scene_ph) placeholders.push(i + 1);
      }
      clips.push(spec);
      bar(30 + Math.trunc((i + 1) / n * 35), 'Клипы…');
    }
    this._build_stage = 'склейка клипов'; log('▶ Склеиваю клипы рилса…');
    let splitSpec = null;
    if (split) {
      const top = this.split_top_path; const isv = this._is_video_file(top);
      splitSpec = { top: (top && vfs.exists(top)) ? { kind: isv ? 'video' : 'image', blob: vfs.read(top) } : null, order: this.split_order };
      log(this.split_order === 'video_bottom' ? '▶ Split-экран: картинки сверху + видео снизу…' : '▶ Split-экран: видео сверху + картинки снизу…');
    }
    bar(68, 'Голос…');
    this._build_stage = 'сведение звука';
    const vlen = segs[segs.length - 1].end; const music = this._pick_music(vlen);
    let musicSpec = null;
    if (music) { try { musicSpec = { buf: await A.resample(await A.decode(music), 44100, 2), db: this.music_db }; log(`▶ Музыка «${path.basename(music)}» (${this.music_db}dB)`); } catch (e) { log(`  ⚠ музыка не декодировалась: ${String(e.message || e).slice(0, 60)}`); } }
    else if (this.music_track) log('ℹ Музыки нет (assets/music/ пуста) — собираю без неё');
    if (!this.sfx_enabled) log('  звуковые эффекты выключены');
    const voiceGain = (this.voice_vol ?? 100) !== 100 ? Math.max(0, (this.voice_vol ?? 100) / 100) : 1;
    bar(74, 'Субтитры…');
    // 4) субтитры
    this._build_stage = 'субтитры';
    log('▶ Выжигаю крупные субтитры…');
    const rstyle = Object.assign({}, style);
    rstyle.size = Math.max(40, Math.trunc(1920 * this.sub_fontpct)); rstyle.outline = Math.max(8, style.outline); rstyle.shadow = Math.max(3, style.shadow);
    const _capzone = _src_frames ? this._effective_cap_zone() : null;
    if (_capzone) this._apply_cap_zone_style(rstyle, _capzone);
    else { const [al, mv] = this._sub_align_marginv(1920, rstyle.size); rstyle.align = al; rstyle.marginv = mv; rstyle.marginl = 100; rstyle.marginr = 100; }
    let word_times = null;
    if (rstyle.anim && !this.no_subs) {
      try {
        const _t0 = now();
        const vp = 'temp/reel_voice.wav'; vfs.write(vp, A.wav(this._voice_buf));
        const _ww = await this._transcribe_words(vp);
        if (_ww.length) {
          let _subw = []; for (const _s of segs) _subw = _subw.concat(pysplit(clean_phrase(_s.text)));
          word_times = align_sub_words(_subw, _ww);
          log(`  ⏱ пословные тайминги (Whisper): ${_ww.length} слов за ${(now() - _t0).toFixed(1)}с`);
        } else log('  ⚠ Whisper без таймингов');
      } catch (e) { log(`  ⚠ тайминги слов не получены (${String(e.message || e).slice(0, 60)})`); word_times = null; }
    }
    let ass = null;
    if (this.no_subs) log('▶ «Без субтитров» включено — собираю рилс без пословных субтитров');
    else ass = build_ass('temp/reel_subs.ass', segs, rstyle, 1080, 1920, this.reel_highlights, null, null, 2, true, rstyle.anim ? word_times : null);
    const title = (this.title_on && this.title_text && this.title_text.trim()) ? { text: this.title_text, xpct: this.title_xpct, ypct: this.title_ypct, fontpct: this.title_fontpct, theme: (this.title_theme in C.TITLE_THEMES) ? this.title_theme : 'T1', split } : null;
    if (title) log('▶ Наложил постоянный заголовок');
    bar(84, 'Концовка…');
    // 5) подгонка длины + финальный кадр + логотип
    this._build_stage = 'финализация';
    const videoLen = clips.reduce((a, c) => a + c.frames, 0) / 30; const contentLen = Math.min(videoLen, this._voice_buf.duration);
    let fit;
    if (this._has_manual_lens || this.tts_engine === 'myvoice') fit = this.tts_engine === 'myvoice' ? this._fit_myvoice_plan(contentLen, this.reel_seconds, 120.0) : this._hard_trim_plan(contentLen, 120.0);
    else fit = this._fit_plan(contentLen, this._target_sec());
    const outro = await this._outro_spec();
    const logo = await this._logo_spec(1080, 1920);
    if (logo) log('▶ Наклеиваю логотип…');
    const tm = strftime('%H%M%S'); out_name = out_name || `rils_${tm}.mp4`;
    bar(86, 'Рендер видео…');
    log('▶ Рендер ролика (кодирование видео в браузере)…');
    const t0 = now();
    const res = await renderReel({ W: 1080, H: 1920, clips, voice: this._voice_buf, voiceGain, music: musicSpec, ass, title, fit, outro, logo, split: splitSpec,
      metaTitle: 'VideoRils Lite ' + APP_VERSION, onProgress: (f) => bar(86 + Math.trunc(f * 12), `Рендер ${Math.trunc(f * 100)}%…`) });
    if (res.ext !== '.mp4') out_name = out_name.replace('.mp4', res.ext);
    const out_path = `output/${out_name}`;
    vfs.write(out_path, res.blob); await vfs.flush(out_path);
    log(`  🎞 рендер: ${res.duration.toFixed(1)}s видео за ${(now() - t0).toFixed(1)}с, ${(res.blob.size / 1048576).toFixed(1)} МБ`);
    this.last_reel = out_path; this._reel_master_path = '';
    log(`✅ Рилс готов: ${out_name}`);
    this._ping_render();
    if (!batch && !this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    const _bad_total = placeholders.length;
    if (placeholders.length) log('⚠ Сцены без медиа (тёмная заглушка): ' + placeholders.map(x => '#' + x).join(', '));
    if (_bad_total) this._degrade(`${_bad_total} сцен(а) не собрались — заменены тёмной заглушкой. Проверь ролик и раскадровку`);
    if (!batch) {
      bar(100, 'Готово');
      this._emit_pix_limit();
      this.track('reel_done');
      call_js('reelDone', out_path, '', _bad_total, (this._BUILD_DEGRADED || []).length);
    }
    return out_path;
  } catch (e) {
    log(`✖ Ошибка сборки рилса: ${e.message || e}`);
    if (batch) throw e;
    try { this.report_client_error('reel_build_failed', `${e.name || 'Error'}: ${e.message || e}`, 'сборка'); } catch (e2) { }
    this.track('generate_failed', String(e.message || e).slice(0, 120));
    call_js('reelDone', '', String(e.message || e).slice(0, 200));
    return null;
  } finally { if (!batch) { this.busy = false; this._reel_used_clips = null; _build_log_close(); } }
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
P.get_reel_preview_url = async function () {
  const src = this.last_reel || ''; if (!src || !vfs.exists(src)) return { ok: false };
  const dst = 'temp/preview_reel' + path.splitext(src)[1]; vfs.copy(src, dst); await vfs.flush(dst);
  return { ok: true, url: dst + '?t=' + Math.trunc(now()) };
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
