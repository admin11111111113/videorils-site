// Порт Api: раскадровка — предпрослушка, ударения, переподбор, добавить/удалить/перегенерировать,
// проверка, «Другой клип», кандидаты, свой файл, превью сцен (app.py 9842–11036).
import { C, log, re, pystrip, pysplit, vfs, path, call_js, now, pickFiles, _build_log_open, _build_log_close } from './core.js';
import {
  _query_variants, _pixabay_query, _download, _rel_tokens, _hit_rel, _topic_domain, _query_content_tokens, _rank_video_hits, _rank_photo_hits,
  _is_weak_pick, _wikimedia_search, MediaProviderChain, PIX,
} from './media.js';
import { makeThumb, probeOk } from './thumbs.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const MEDIA_IMG = C['Api.MEDIA_IMG'], MEDIA_VID = C['Api.MEDIA_VID'];

P.scene_preview_audio = async function (idx, engine = 'edge') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const txt = (this.reel_scenes[idx].text || '').trim();
  if (!txt) return { ok: false, msg: this._t('bad_scenario') };
  const [merged, changed] = await this._merge_manual_stress(txt, this.reel_scenes[idx].stress, this.reel_scenes[idx].stress_manual);
  const use_final = engine === 'final';
  const is_eleven = use_final && this.tts_engine === 'eleven' && !!this.eleven_key && this.licensed;
  const eng_id = use_final ? this.tts_engine : 'edge';
  const key = `${eng_id}|${merged}`;
  const cache = (this._scene_prev_cache = this._scene_prev_cache || {});
  const out = `temp/scene_preview_${idx}.mp3`, url = out;
  if (cache[idx] === key && vfs.exists(out) && vfs.size(out) > 0) return { ok: true, url, cached: true, eleven: is_eleven, chars: [...merged].length };
  const prev_force = this._force_edge;
  try { if (!use_final) this._force_edge = true; await this._synth_one(merged, out, { keep_stress: changed }); }
  catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 80) }; }
  finally { this._force_edge = prev_force; }
  if (!(vfs.exists(out) && vfs.size(out) > 0)) return { ok: false, msg: this._t('toast_error') };
  await vfs.flush(out);
  cache[idx] = key;
  return { ok: true, url, cached: false, eleven: is_eleven, chars: [...merged].length };
};
P.scene_stress = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const sc = this.reel_scenes[idx];
  if (!sc.stress) sc.stress = await this._mark_stress(sc.text || '');
  return { ok: true, stress: sc.stress || '', homographs: this._scene_homographs(sc.text || '') };
};
P.scenes_stress = async function () {
  const _need = this.reel_scenes.filter(s => !s.stress).map(s => s.text || '');
  const marks = _need.length ? await this._mark_stress_all(_need) : {};
  const out = this.reel_scenes.map((sc, i) => { if (!sc.stress) sc.stress = marks[(sc.text || '').trim()] || ''; return { idx: i, stress: sc.stress || '', homographs: this._scene_homographs(sc.text || '') }; });
  return { ok: true, scenes: out };
};
P.set_scene_stress = function (idx, stress_text, manual_idxs = null) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const sc = this.reel_scenes[idx]; const st = stress_text || '';
  if (Api._letters_only(st) !== Api._letters_only(sc.text || '')) return { ok: false };
  sc.stress = st;
  try { sc.stress_manual = [...new Set((manual_idxs || []).map(x => parseInt(x)).filter(x => !Number.isNaN(x)))].sort((a, b) => a - b); } catch (e) { sc.stress_manual = []; }
  this._persist();
  return { ok: true };
};
P.set_auto_rematch = function (on) { this.auto_rematch = !!on; this._persist(); return { ok: true, auto: this.auto_rematch }; };
P.scene_rematch = async function (idx) {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const sc = this.reel_scenes[idx];
  if (sc.cta) return { ok: false, msg: this._t('bad_scenario') };
  const text = (sc.text || '').trim(); let query = '';
  const prompt = `Тема рилса: ${this.reel_topic || '—'}. Фраза сцены: «${text}».\nДай english_query для поиска СТОКОВОГО видео, которое БЬЁТ В СМЫСЛ фразы (визуальная метафора, не пересказ слов): снимаемый объект + контекст + тип кадра (aerial/close up/timelapse/interior). 3-5 конкретных английских слов, без абстракций (success/growth/business). Верни РОВНО одну строку: QUERY|english query`;
  try {
    const [ok, out] = await this._ai_call(prompt, null, 300);
    if (ok && out) { const line = (out.trim().split('\n')[0] || ''); query = (line.includes('|') ? line.split('|').slice(1).join('|') : line).trim().slice(0, 60); }
  } catch (e) { }
  if (!query) { const kws = [...this._rm_keywords(text)].slice(0, 3); query = (kws.join(' ') || this.reel_topic || 'cinematic background').trim(); }
  Object.assign(sc, { query, clip: '', preview: '', pick: null, start: 0, locked: false, orig_text: text });
  return { ok: true, query, scenes: this.get_scenes().scenes };
};
P.scene_set_query = function (idx, query) {
  if (idx >= 0 && idx < this.reel_scenes.length) Object.assign(this.reel_scenes[idx], { query: (query || '').trim(), clip: '', preview: '', pick: null, start: 0 });
  return { ok: true };
};
P.scene_set_start = function (idx, seconds) {
  if (idx >= 0 && idx < this.reel_scenes.length) { const v = parseFloat(seconds); this.reel_scenes[idx].start = Number.isNaN(v) ? 0 : Math.max(0.0, v); }
  return { ok: true, start: (idx >= 0 && idx < this.reel_scenes.length) ? (this.reel_scenes[idx].start || 0) : 0 };
};
P.scene_delete = function (idx) { if (idx >= 0 && idx < this.reel_scenes.length) this.reel_scenes.splice(idx, 1); return this.get_scenes(); };
P.scene_add = function (idx) {
  const placeholder = this.video_lang === 'en' ? 'New reel line' : 'Новая фраза рилса';
  const sc = { text: placeholder, query: 'cinematic background', kw: '', clip: '', preview: '' };
  if (idx >= 0 && idx < this.reel_scenes.length) this.reel_scenes.splice(idx + 1, 0, sc); else this.reel_scenes.push(sc);
  return this.get_scenes();
};
P.scene_regen = async function (idx, direction = '') {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (this.reel_scenes[idx].cta) return { ok: false, msg: this._t('bad_scenario') };
  const sc = this.reel_scenes[idx]; const en = this.video_lang === 'en';
  const ctx = this.reel_scenes.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  let prompt;
  if (en) {
    let extra = C['Api._REGEN_DIRECTIONS_EN'][(direction || '').trim()] || ''; extra = extra ? '\nESPECIALLY: ' + extra + '\n' : '';
    prompt = 'Here are the lines of a finished reel:\n' + ctx + '\n\n' + `Rewrite ONLY line #${idx + 1} ("${sc.text}") — same topic and style, connected to its neighbors, but a DIFFERENT phrasing/detail. A full natural sentence, 8-16 words.` + extra + ' Return EXACTLY one line and nothing else:\nPHRASE|new text|english_query (3-4 concrete words, the object from the phrase verbatim)|keyword';
  } else {
    let extra = C['Api._REGEN_DIRECTIONS'][(direction || '').trim()] || ''; extra = extra ? '\nОСОБО: ' + extra + '\n' : '';
    prompt = 'Вот фразы готового рилса:\n' + ctx + '\n\n' + `Перепиши ТОЛЬКО фразу №${idx + 1} ("${sc.text}") — в той же теме и стиле, связно с соседними, но ДРУГОЙ формулировкой/деталью. Полное живое предложение 8-16 слов.` + extra + ' Верни РОВНО одну строку и больше ничего:\nФРАЗА|новый текст|english_query (3-4 конкретных слова, объект из фразы дословно)|ключевое_слово';
  }
  let [ok, out] = await this._ai_call(prompt, null, 600);
  if (!ok) { log(`  ⚠ регенерация фразы: ИИ не ответил (причина=${this._ai_last_reason || '—'}, HTTP=${this._ai_last_status || 0}) — повтор`); [ok, out] = await this._ai_call(prompt, null, 600); }
  if (!ok) return { ok: false, msg: out, manual: true, code: this._ai_last_reason };
  const [ph, im, hl] = this._parse_reel_answer(out);
  if (ph.length) {
    sc.text = ph[0]; delete sc.stress; delete sc.stress_manual; delete sc.homographs;
    if (im[1]) sc.query = im[1];
    sc.kw = hl[1] ? [...hl[1]].sort().join(' ') : sc.kw;
    Object.assign(sc, { clip: '', preview: '', pick: null, start: 0 });
  }
  return { ok: true, scene: { text: sc.text, query: sc.query, kw: sc.kw } };
};
P.reel_precheck = function () {
  const texts = (this.reel_scenes || []).filter(s => !s.cta).map(s => s.text || '');
  const where = {};
  texts.forEach((tx, i) => { for (const w of new Set(re.findall('[а-яёa-z]{5,}', (tx || '').toLowerCase()))) if (!C['Api._PRECHECK_STOP'].has(w)) (where[w] = where[w] || new Set()).add(i); });
  const repeats = Object.keys(where).filter(w => where[w].size >= 2).sort();
  return { ok: true, repeats: repeats.slice(0, 12) };
};
P.get_media_source = async function () { return { pexels_available: !!this.pexels_key, pixabay_available: !!(await this._active_pixabay_key()) }; };

P._clip_valid = async function (p, is_video) { return await probeOk(p, is_video); };
P.scene_swap_clip = async function (idx, source = 'pexels') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (this.reel_scenes[idx].cta) return { ok: false, msg: this._t('bad_scenario') };
  source = source === 'pixabay' ? 'pixabay' : 'pexels';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !(await this._active_pixabay_key())) return { ok: false, msg: this._t('m2_no_key') };
  this._scene_swap_worker(idx, source);
  return { ok: true, pending: true };
};
P._scene_swap_worker = async function (idx, source = 'pexels') {
  _build_log_open(true, `swap scene ${idx + 1}`);
  const t_start = now(), deadline = t_start + 30;
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  const busy = new Set(this._scene_used_ids(idx)); const _cur = (sc.pick || {}).id; if (_cur != null) busy.add(_cur);
  const seenKey = `${source}:${q}`; const seen = (this._swap_seen[seenKey] = this._swap_seen[seenKey] || new Set());
  for (const x of seen) busy.add(x);
  const key = await this._active_pixabay_key();
  log(`▶ [другой клип] сцена ${idx + 1} «${q}», источник=${source}, ключ=${this._key_source_label()}, потолок 30с`);
  let limited = false;
  try {
    const _pixabay_cands = async () => {
      const out = [];
      for (const v of _query_variants(q, this.reel_topic)) {
        if (out.length || now() > deadline) break;
        let hits, lim;
        try { [hits, lim] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 30, false); } catch (e) { log(`  ⚠ поиск: ${String(e.message || e).slice(0, 50)}`); continue; }
        if (lim) { limited = true; continue; }
        for (const h of (hits || [])) {
          if (busy.has(h.id)) continue;
          const vids = h.videos || {}; const u = (vids.small || vids.tiny || vids.medium || vids.large || {}).url;
          if (u) out.push({ id: h.id, url: u, tags: h.tags || '' });
        }
      }
      return out;
    };
    const _pexels_cands = async () => {
      if (!this.pexels_key) return [];
      const out = [];
      try { for (const pc of await this._pexels_vids(q, 20)) if (pc.url && !busy.has(pc.id)) out.push({ id: pc.id, url: pc.url, tags: '' }); }
      catch (e) { log(`  ⚠ Медиа 1 (Pexels): ${String(e.message || e).slice(0, 50)}`); }
      return out;
    };
    const cands = source === 'pexels' ? await _pexels_cands() : await _pixabay_cands();
    if (!cands.length) {
      const note = source === 'pexels' ? this._t('m1_empty') : (limited ? this._t('pix_limit_note') : this._t('m2_empty'));
      log(`  ⚠ сцена ${idx + 1}: замена не найдена (источник ${source}, limited=${limited})`);
      call_js('sceneClipDone', { idx, ok: false, msg: note }); return;
    }
    let tried = 0;
    for (const c of cands) {
      if (now() > deadline || tried >= 3) break;
      tried++;
      const clip = `temp/scene_${idx}_clip.mp4`;
      try {
        await _download(c.url, clip, 10);
        if (!(await this._clip_valid(clip, true))) throw new Error('битый/0-байт');
        await makeThumb(clip, `temp/scene_${idx}_thumb.jpg`, 240);
      } catch (e) { log(`  ⚠ клип id ${c.id} не скачался/битый (${String(e.message || e).slice(0, 40)}) → следующий`); continue; }
      sc.clip = clip; const thumb = `temp/scene_${idx}_thumb.jpg`;
      const _strong = _rel_tokens(this.reel_topic);
      const _weak = !!(c.tags || '').trim() && !!_strong.size && !_hit_rel(c, _strong);
      sc.pick = { id: c.id, url: c.url, source, is_video: true, thumb, weak: _weak };
      seen.add(c.id); this._thumb_tick++;
      log(`  🎬 сцена ${idx + 1}: клип от ${source === 'pexels' ? 'Pexels' : 'Pixabay'} по запросу «${q}» → id ${c.id} за ${(now() - t_start).toFixed(1)}с (уникальный)`);
      call_js('sceneClipDone', { idx, ok: true, weak: _weak, thumb: `${thumb}?t=${this._thumb_tick}` }); return;
    }
    const msg = limited ? 'media_limit' : 'media_empty';
    log(`  ⚠ сцена ${idx + 1}: замена не нашлась за ${(now() - t_start).toFixed(1)}с (${limited ? 'лимит 429' : 'пусто'})`);
    call_js('sceneClipDone', { idx, ok: false, msg: this._t(msg) });
  } catch (e) { call_js('sceneClipDone', { idx, ok: false, msg: String(e.message || e).slice(0, 80) }); }
  finally { _build_log_close(); }
};
Api._hit_thumb_url = function (h) {
  const vids = h.videos || {};
  for (const sz of ['tiny', 'small', 'medium', 'large']) { const t = (vids[sz] || {}).thumbnail; if (t) return t; }
  return h.thumbnail || h.userImageURL || '';
};
P._swap_fetch_cands = async function (source, q) {
  const out = [];
  if (source === 'pexels') {
    if (!this.pexels_key) return out;
    try { for (const pc of await this._pexels_vids(q, 20)) if (pc.url) out.push({ id: pc.id, url: pc.url, thumb: pc.thumb || '', tags: '' }); }
    catch (e) { log(`  ⚠ Медиа 1 (Pexels): ${String(e.message || e).slice(0, 50)}`); }
    return out;
  }
  if (source === 'wikimedia') { for (const c of await _wikimedia_search(q, 20)) out.push({ id: c.id, url: c.url, thumb: c.thumb, tags: c.tags || '', is_video: false, license: c.license || '' }); return out; }
  const key = await this._active_pixabay_key(); if (!key) return out;
  for (const v of _query_variants(q, this.reel_topic)) {
    if (out.length) break;
    let hits, lim;
    try { [hits, lim] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 30, false); } catch (e) { log(`  ⚠ поиск: ${String(e.message || e).slice(0, 50)}`); continue; }
    if (lim) continue;
    for (const h of (hits || [])) { const vids = h.videos || {}; const u = (vids.small || vids.tiny || vids.medium || vids.large || {}).url; if (u) out.push({ id: h.id, url: u, thumb: Api._hit_thumb_url(h), tags: h.tags || '' }); }
  }
  return out;
};
P.scene_swap_candidates = async function (idx, source = 'pexels') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (this.reel_scenes[idx].cta) return { ok: false, msg: this._t('bad_scenario') };
  if (!['pexels', 'pixabay', 'wikimedia'].includes(source)) source = 'pexels';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !(await this._active_pixabay_key())) return { ok: false, msg: this._t('m2_no_key') };
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  let st = this._scene_swap_state[idx];
  if (!st || st.source !== source || st.q !== q) { st = { source, q, cands: await this._swap_fetch_cands(source, q), offered: [] }; this._scene_swap_state[idx] = st; }
  if (!st.cands.length) return { ok: false, msg: this._t({ pexels: 'm1_empty', pixabay: 'm2_empty', wikimedia: 'wiki_empty' }[source] || 'm2_empty') };
  const busy = new Set(this._scene_used_ids(idx)); const _cur = (sc.pick || {}).id; if (_cur != null) busy.add(_cur);
  const sk = `${source}:${q}`; const seen = (this._swap_seen[sk] = this._swap_seen[sk] || new Set());
  const add_n = st.offered.length ? 1 : 3; let added = 0;
  for (const c of st.cands) {
    if (added >= add_n) break;
    const hid = c.id; if (hid == null || st.offered.includes(hid) || busy.has(hid)) continue;
    st.offered.push(hid); seen.add(hid); added++;
  }
  const by_id = new Map(st.cands.map(c => [c.id, c]));
  return { ok: true, candidates: st.offered.map(hid => ({ id: hid, source, thumb: (by_id.get(hid) || {}).thumb || '' })), exhausted: added === 0, source };
};
P.scene_source_probe = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const sc = this.reel_scenes[idx]; if (sc.cta) return { ok: false };
  const q = sc.query || 'background';
  const cache = (this._src_probe_cache = this._src_probe_cache || {});
  if (q in cache) return Object.assign({ ok: true }, cache[q]);
  const have_pex = !!this.pexels_key, have_pix = !!(await this._active_pixabay_key());
  const res = {}; if (!have_pex) res.pexels = 'nokey'; if (!have_pix) res.pixabay = 'nokey';
  const probe = (src) => this._swap_fetch_cands(src, q).then(r => !!r.length).catch(() => false);
  const jobs = []; if (have_pex) jobs.push('pexels'); if (have_pix) jobs.push('pixabay'); jobs.push('wikimedia');
  let notdone = false;
  await Promise.all(jobs.map(src => Promise.race([probe(src).then(v => { res[src] = v ? 'has' : 'empty'; }), new Promise(r => setTimeout(() => { if (!(src in res)) { res[src] = 'empty'; notdone = true; } r(); }, 4000))])));
  if (!notdone) cache[q] = Object.assign({}, res);
  return Object.assign({ ok: true }, res);
};
P.scene_swap_restart = async function (idx, source = 'pexels') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (!['pexels', 'pixabay', 'wikimedia'].includes(source)) source = 'pexels';
  const q = this.reel_scenes[idx].query || 'background';
  delete this._swap_seen[`${source}:${q}`];
  const st = this._scene_swap_state[idx]; if (st && st.source === source && st.q === q) st.offered = [];
  return await this.scene_swap_candidates(idx, source);
};
P.scene_pick_candidate = async function (idx, source, hit_id) {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const st = this._scene_swap_state[idx]; if (!st) return { ok: false, msg: this._t('m2_empty') };
  const n = parseInt(hit_id); if (!Number.isNaN(n) && String(n) === String(hit_id)) hit_id = n;
  const c = st.cands.find(x => x.id === hit_id); if (!c) return { ok: false, msg: this._t('m2_empty') };
  if (!['pexels', 'pixabay', 'wikimedia'].includes(source)) source = 'pexels';
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  if (source === 'wikimedia') {
    try {
      const dst = `temp/scene_${idx}_clip.jpg`;
      await _download(c.url, dst, 15);
      if (!(await probeOk(dst, false))) return { ok: false, msg: this._t('m2_empty') };
      await makeThumb(dst, `temp/scene_${idx}_thumb.jpg`, 240);
      sc.clip = dst; sc.pick = { id: c.id, source: 'wikimedia', is_video: false, thumb: `temp/scene_${idx}_thumb.jpg`, weak: false }; sc.locked = true; this._thumb_tick++;
      log(`  🏛 сцена ${idx + 1}: Wikimedia (лиц. ${c.license}) id ${c.id} по запросу «${q}»`);
      return { ok: true, approx: false, kind: 'image', thumb: `temp/scene_${idx}_thumb.jpg?t=${this._thumb_tick}` };
    } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 80) }; }
  }
  try {
    const clip = `temp/scene_${idx}_clip.mp4`;
    await _download(c.url, clip, 10);
    if (!(await this._clip_valid(clip, true))) return { ok: false, msg: this._t('m2_empty') };
    await makeThumb(clip, `temp/scene_${idx}_thumb.jpg`, 240);
    const _strong = _rel_tokens(this.reel_topic); const _weak = !!(c.tags || '').trim() && !!_strong.size && !_hit_rel(c, _strong);
    const thumb = `temp/scene_${idx}_thumb.jpg`;
    sc.clip = clip; sc.pick = { id: c.id, url: c.url, source, is_video: true, thumb, weak: _weak }; sc.locked = true; this._thumb_tick++;
    log(`  🎬 сцена ${idx + 1}: выбран клип от ${source === 'pexels' ? 'Pexels' : 'Pixabay'} по запросу «${q}» → id ${c.id}`);
    return { ok: true, approx: _weak, thumb: `${thumb}?t=${this._thumb_tick}` };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 80) }; }
};
P.scene_upload_file = function (idx) {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (this.reel_scenes[idx].cta) return { ok: false, msg: this._t('bad_scenario') };
  return pickFiles('image/*,video/*').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    const f = files[0]; const ext = path.splitext(f.name)[1].toLowerCase();
    if (![...MEDIA_IMG, ...MEDIA_VID].includes(ext)) return { ok: false, msg: this._t('file_not_selected') };
    const p = `input/scene_${idx}_${Date.now()}${ext}`; vfs.write(p, f);
    try { await makeThumb(p, `temp/scene_${idx}_thumb.jpg`, 240); } catch (e) { }
    Object.assign(this.reel_scenes[idx], { clip: p, preview: '', locked: true });
    this._thumb_tick++;
    return { ok: true, name: f.name, thumb: `temp/scene_${idx}_thumb.jpg?t=${this._thumb_tick}` };
  });
};

P._pixabay_pick = async function (query, used) {
  const key = await this._active_pixabay_key();
  const variants = _query_variants(query, this.reel_topic);
  const dom = _topic_domain(this.reel_topic) || _topic_domain(query);
  const want = this._avg_scene_dur(); const strong = _rel_tokens(this.reel_topic); const qtoks = _query_content_tokens(query);
  const specific = new Set(variants.slice(0, C['Api._SPECIFIC_VARIANT_CUTOFF'])); const pexels_first = !!this.pexels_key;
  const MIN = C['Api._SCENE_MIN_CONFIDENT'];
  const _conf = (h) => strong.size ? _hit_rel(h, strong) : (qtoks.size ? _hit_rel(h, qtoks) : true);
  const confident = []; let fallback = null;
  const _consider = (item, ok) => { if (ok) confident.push(item); else if (fallback === null) fallback = item; return confident.length >= MIN; };
  const _scan_pexels = async () => {
    if (!this.pexels_key) return false;
    try {
      for (const v of variants) {
        const pex = (await this._pexels_vids(v, 20)) || []; if (!pex.length) continue;
        const vspec = specific.has(v);
        for (const c of pex) { if (used.has(c.id) || !c.url) continue; if (_consider({ id: c.id, is_video: true, url: c.url, thumb: c.thumb || '', source: 'pexels' }, vspec)) return true; }
        return false;
      }
    } catch (e) { log(`  ⚠ Pexels: ${String(e.message || e).slice(0, 50)}`); }
    return false;
  };
  const _scan_pixabay_video = async () => {
    if (!key) return false;
    for (const v of variants) {
      let hits, limited; try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 20, false); } catch (e) { continue; }
      if (limited || !hits || !hits.length) continue;
      const cands = [];
      for (const h of _rank_video_hits(hits, dom, want, v)) {
        if (used.has(h.id)) continue;
        const vids = h.videos || {}; const url = (vids.medium || vids.small || vids.tiny || vids.large || {}).url; if (!url) continue;
        let thumb = ''; for (const sz of ['medium', 'small', 'large', 'tiny']) { thumb = (vids[sz] || {}).thumbnail; if (thumb) break; }
        if (!thumb) { const pid = h.picture_id; thumb = h.userImageURL || (pid ? `https://i.vimeocdn.com/video/${pid}_295x166.jpg` : ''); }
        cands.push([Number(h.duration || 0), h, url, thumb]);
      }
      if (!cands.length) continue;
      const good = cands.filter(c => c[0] >= 4.0);
      const [, h, url, thumb] = good.length ? good[0] : cands.reduce((a, b) => b[0] > a[0] ? b : a);
      _consider({ id: h.id, is_video: true, url, thumb, source: 'pixabay' }, _conf(h));
      return false;
    }
    return false;
  };
  if (pexels_first) { if (!(await _scan_pexels())) await _scan_pixabay_video(); }
  else { if (!(await _scan_pixabay_video())) await _scan_pexels(); }
  if (confident.length < MIN && key) {
    for (const v of variants) {
      let hits, limited; try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, v, 20, true); } catch (e) { continue; }
      if (limited || !hits || !hits.length) continue;
      for (const h of _rank_photo_hits(hits, dom, v)) {
        if (used.has(h.id)) continue;
        const url = h.largeImageURL || h.webformatURL; if (!url) continue;
        if (_consider({ id: h.id, is_video: false, url, thumb: h.webformatURL || h.previewURL || url, source: 'pixabay' }, _conf(h))) break;
      }
      if (confident.length >= MIN) break;
    }
  }
  if (confident.length >= MIN) { const c = confident[0]; c.weak = false; return c; }
  const wm = await this._wikimedia_pick(query, used);
  if (wm) { wm.weak = false; log(`     🏛 Wikimedia (архив, лиц. ${wm.license}) id ${wm.id} — запасной (Pexels/Pixabay без релевантного)`); return wm; }
  if (fallback !== null) { fallback.weak = true; return fallback; }
  return null;
};
P._wikimedia_pick = async function (query, used) { used = used || new Set(); for (const c of await _wikimedia_search(query, 20)) if (!used.has(c.id)) return c; return null; };
P._avg_scene_dur = function () { const n = Math.max(1, (this.reel_scenes || []).filter(s => (s.text || '').trim() && !s.cta).length); return Number(this.reel_seconds || 30) / n; };
P._scene_used_ids = function (skip = null) { const s = new Set(); this.reel_scenes.forEach((x, j) => { if (j !== skip && x.pick && x.pick.id) s.add(x.pick.id); }); return s; };
P._fetch_candidates = async function (query, key) {
  const out = []; const variants = _query_variants(query, this.reel_topic).slice(0, 2);
  const dom = _topic_domain(this.reel_topic) || _topic_domain(query); const want = this._avg_scene_dur();
  for (const v of variants) {
    let hits, limited; try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 20, false); } catch (e) { continue; }
    if (limited) return out;
    if (!hits || !hits.length) continue;
    for (const h of _rank_video_hits(hits, dom, want, query)) {
      const vids = h.videos || {}; const vv = vids.medium || vids.small || vids.tiny || vids.large || {}; const u = vv.url; if (!u) continue;
      let th = ''; for (const sz of ['medium', 'small', 'large', 'tiny']) { th = (vids[sz] || {}).thumbnail; if (th) break; }
      out.push({ id: h.id, is_video: true, url: u, thumb: th, source: 'pixabay', w: vv.width || 0, h: vv.height || 0, weak: _is_weak_pick(h.tags || '', dom, query) });
    }
    if (out.length) return out;
  }
  let hits = [], limited = false;
  try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, variants.length ? variants[0] : query, 20, true); } catch (e) { hits = []; limited = false; }
  if (!limited && hits && hits.length) for (const h of _rank_photo_hits(hits, dom, query)) {
    const u = h.largeImageURL || h.webformatURL; if (!u) continue;
    out.push({ id: h.id, is_video: false, url: u, thumb: h.webformatURL || h.previewURL || u, source: 'pixabay', w: h.imageWidth || 0, h: h.imageHeight || 0, weak: _is_weak_pick(h.tags || '', dom, query) });
  }
  return out;
};
P._media_chain = function () {
  const sig = this.pexels_key;
  if (!this._media_chain_obj || this._media_chain_sig !== sig) { this._media_chain_obj = new MediaProviderChain(this.pexels_key, null, log); this._media_chain_sig = sig; }
  return this._media_chain_obj;
};
P._reset_key_rotation = function () { this._pix_key_idx = 0; PIX.LIMIT_HIT = false; this.pexels_idx = 0; this.eleven_idx = 0; this.gemini_idx = 0; this.claude_idx = 0; this._media_chain_obj = null; };
P._pexels_advance = function () { const n = (this.pexels_keys || []).length; if (n <= 1) return false; this.pexels_idx = (this.pexels_idx + 1) % n; this._media_chain_obj = null; log(`  ↩ Pexels ключ → #${this.pexels_idx + 1}/${n} (лимит/отказ предыдущего)`); return true; };
P._pexels_vids = async function (query, per_page = 20) {
  const n = Math.max(1, (this.pexels_keys || [1]).length);
  for (let i = 0; i < n; i++) {
    const chain = this._media_chain(); let res;
    try { res = await chain.pexels_videos(query, per_page); } catch (e) { res = []; }
    if (res.length || !chain.pexels_limited) return res;
    if (!this._pexels_advance()) return res;
  }
  return [];
};
P._pixabay_candidates = async function (query) {
  const cache = (this._pix_cand_cache = this._pix_cand_cache || {});
  if (cache[query] && cache[query].length) return cache[query];
  const pexels_first = !!this.pexels_key;
  const _pixabay_out = async () => {
    const key = await this._active_pixabay_key(); if (!key) return [];
    log(`  ▶ превью «${query}»: ключ-источник = ${this._key_source_label()}`);
    let pix = await this._fetch_candidates(query, key);
    while (!pix.length && PIX.LIMIT_HIT && this._rotate_pixabay_key()) pix = await this._fetch_candidates(query, await this._active_pixabay_key());
    return pix;
  };
  const _pexels_out = async () => {
    for (const v of _query_variants(query, this.reel_topic)) {
      let pex; try { pex = await this._pexels_vids(v, 20); } catch (e) { log(`  ⚠ Pexels «${v}»: ${String(e.message || e).slice(0, 50)}`); pex = []; }
      if (pex.length) return pex;
    }
    return [];
  };
  let out;
  if (pexels_first) { out = await _pexels_out(); if (!out.length) out = await _pixabay_out(); }
  else {
    if (!(await this._active_pixabay_key())) { log(`  ⚠ превью «${query}»: Media-ключ недоступен (источник: ${this._key_source_label()}) — заглушка`); return []; }
    out = await _pixabay_out();
  }
  if (out.length) cache[query] = out;
  return out;
};
P.scene_previews_all = async function () {
  const used = new Set(); for (const s of this.reel_scenes) if (s.pick && s.pick.id) used.add(s.pick.id);
  const need = this.reel_scenes.map((s, i) => i).filter(i => { const s = this.reel_scenes[i]; return !s.cta && !s.clip && !s.pick; });
  const cand = {};
  if (need.length) {
    log(`▶ Превью раскадровки: тянем клипы для ${need.length} сцен (2 параллельно + троттлинг Pixabay, чтобы не ловить 429)…`);
    const t0 = now(); let qi = 0;
    const worker = async () => { while (qi < need.length) { const i = need[qi++]; try { cand[i] = await this._pixabay_candidates(this.reel_scenes[i].query || 'background'); } catch (e) { log(`  сцена ${i + 1}: превью не удалось — ${String(e.message || e).slice(0, 50)}`); cand[i] = []; } } };
    await Promise.all(Array.from({ length: Math.min(2, need.length) }, worker));
    log(`  превью подобраны за ${(now() - t0).toFixed(1)}с`);
  }
  const out = [];
  this.reel_scenes.forEach((s, i) => {
    if (s.cta) { out.push({ i, thumb: '', weak: false }); return; }
    if (s.clip) { out.push({ i, thumb: this._scene_thumb_url(i, s), weak: false }); return; }
    if (!s.pick) {
      const pick = (cand[i] || []).find(c => !used.has(c.id));
      if (pick) { used.add(pick.id); s.preview = pick.thumb; s.pick = pick; } else s.preview = '';
    }
    out.push({ i, thumb: s.preview || '', weak: !!(s.pick || {}).weak, is_video: !!((s.pick || {}).is_video ?? true) });
  });
  return { previews: out };
};
P.scene_preview = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const s = this.reel_scenes[idx];
  if (s.clip) return { ok: true, thumb: this._scene_thumb_url(idx, s) };
  if (s.pick) return { ok: true, thumb: s.preview || '' };
  const pick = await this._pixabay_pick(s.query || 'background', this._scene_used_ids(idx));
  if (pick) { s.preview = pick.thumb; s.pick = pick; return { ok: true, thumb: pick.thumb, weak: !!pick.weak, is_video: !!(pick.is_video ?? true) }; }
  return { ok: false, thumb: '' };
};
P.scene_reload_preview = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const s = this.reel_scenes[idx];
  if (s.cta) return { ok: false, msg: this._t('bad_scenario') };
  if (s.clip) return { ok: true, thumb: this._scene_thumb_url(idx, s) };
  if (!(await this._active_pixabay_key())) return { ok: false, msg: this._t('need_media_key') };
  const q = s.query || 'background';
  try { delete this._pix_cand_cache[q]; } catch (e) { }
  s.pick = null; s.preview = '';
  log(`  ↻ перегрузка превью сцены ${idx + 1} «${q}» (ключ-источник: ${this._key_source_label()})`);
  const pick = await this._pixabay_pick(q, this._scene_used_ids(idx));
  if (pick) { s.preview = pick.thumb; s.pick = pick; return { ok: true, thumb: pick.thumb, weak: !!pick.weak, is_video: !!(pick.is_video ?? true) }; }
  return { ok: false, msg: this._t('media_empty') };
};
P._pixabay_play_url = async function (query) {
  const key = await this._active_pixabay_key(); if (!key) return [null, ''];
  const variants = _query_variants(query, this.reel_topic);
  for (const v of variants) { try { const [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 12, false); if (limited || !hits || !hits.length) continue; const vids = hits[0].videos || {}; const u = (vids.medium || vids.small || vids.tiny || vids.large || {}).url; if (u) return ['video', u]; } catch (e) { } }
  for (const v of variants) { try { const [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, v, 12, true); if (limited || !hits || !hits.length) continue; const h = hits[0]; return ['image', h.largeImageURL || h.webformatURL || '']; } catch (e) { } }
  return [null, ''];
};
P.scene_play = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const s = this.reel_scenes[idx]; const clip = s.clip;
  if (clip && vfs.exists(clip)) {
    const is_vid = this._is_video_file(clip); const ext = path.splitext(clip)[1].toLowerCase() || (is_vid ? '.mp4' : '.jpg');
    const dst = `temp/scene_play_${idx}${ext}`; if (clip !== dst) vfs.copy(clip, dst); await vfs.flush(dst);
    this._thumb_tick++;
    return { ok: true, kind: is_vid ? 'video' : 'image', url: `temp/${path.basename(dst)}?t=${this._thumb_tick}` };
  }
  const pick = s.pick;
  if (pick && pick.url) return { ok: true, kind: pick.is_video ? 'video' : 'image', url: pick.url };
  const [kind, url] = await this._pixabay_play_url(s.query || 'background');
  if (!url) return { ok: false, msg: this._t('ai_empty') };
  return { ok: true, kind, url };
};
