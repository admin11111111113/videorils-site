// Порт Api: раскадровка — предпрослушка, ударения, переподбор, добавить/удалить/перегенерировать,
// проверка, «Другой клип», кандидаты, свой файл, превью сцен (app.py 9842–11036).
import { C, log, re, pystrip, pysplit, vfs, path, call_js, now, pickFiles, _build_log_open, _build_log_close } from './core.js';
import {
  _query_variants, _pixabay_query, _download, _rel_tokens, _hit_tag_overlap, _topic_domain, _query_content_tokens, _rank_video_hits,
  _wikimedia_search, MediaProviderChain, PIX,
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
  const is_eleven = use_final && this.tts_engine === 'eleven' && !!this.eleven_key;
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
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const sc = this.reel_scenes[idx];
  const text = (sc.text || '').trim(); let query = '';
  const prompt = `Тема рилса: ${this.reel_topic || '—'}. Фраза сцены: «${text}».\nДай english_query для СТОКОВОГО видео, которое БЬЁТ В СМЫСЛ фразы (визуальная метафора): объект + контекст + тип кадра (aerial/close up/timelapse/interior). 3-5 конкретных английских слов, без абстракций. Верни РОВНО одну строку: QUERY|english query`;
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
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
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
  const [ok, out] = await this._ai_call(prompt, null, 600);
  if (!ok) return { ok: false, msg: out, manual: true };
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
  const texts = (this.reel_scenes || []).map(s => s.text || '');
  const where = {};
  texts.forEach((tx, i) => { for (const w of new Set(re.findall('[а-яёa-z]{5,}', (tx || '').toLowerCase()))) if (!C['Api._PRECHECK_STOP'].has(w)) (where[w] = where[w] || new Set()).add(i); });
  const repeats = Object.keys(where).filter(w => where[w].size >= 2).sort();
  return { ok: true, repeats: repeats.slice(0, 12) };
};
P.get_media_source = function () { return { pexels_available: !!this.pexels_key, pixabay_available: !!this.pixabay_keys.length }; };

P._clip_valid = async function (p, is_video) { return await probeOk(p, is_video); };
// клип -> temp/scene_{i}_clip.mp4 + миниатюра 240px
async function _dl_clip(idx, url, ext = '.mp4', is_video = true) {
  const clip = `temp/scene_${idx}_clip${ext}`;
  await _download(url, clip);
  if (!(await probeOk(clip, is_video))) throw new Error('битый/0-байт');
  await makeThumb(clip, `temp/scene_${idx}_thumb.jpg`, 240);
  return clip;
}
// «Другой клип 1/2»: следующий клип выбранного банка с антиповтором
P.scene_swap_clip = async function (idx, source = 'pexels') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  source = source === 'pixabay' ? 'pixabay' : 'pexels';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !this.pixabay_keys.length) return { ok: false, msg: this._t('m2_no_key') };
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  const busy = new Set(this._scene_used_ids(idx)); const _cur = (sc.pick || {}).id; if (_cur != null) busy.add(_cur);
  const sk = `${source}:${q}`; const seen = (this._swap_seen[sk] = this._swap_seen[sk] || new Set());
  for (const x of seen) busy.add(x);
  let hits;
  if (source === 'pexels') { try { hits = Api._pexels_hits_as_pixabay(await this._pexels_call('pexels_videos', q, 20)); } catch (e) { log(`  ⚠ Медиа 1 (Pexels): ${String(e.message || e).slice(0, 50)}`); hits = []; } }
  else hits = await this._pixabay_video_hits(q, false);
  const fresh = (hits || []).filter(h => !busy.has(h.id));
  if (!fresh.length) return { ok: false, msg: this._t(source === 'pexels' ? 'm1_empty' : 'm2_empty') };
  const toks = _rel_tokens(this.reel_topic);
  for (const hit of fresh) {
    const vids = hit.videos || {}; const v = vids.medium || vids.small || vids.tiny || vids.large;
    if (!v || !v.url) continue;
    try {
      const clip = await _dl_clip(idx, v.url);
      const ap = !!((hit.tags || '').trim() && toks.size && _hit_tag_overlap(hit, toks) === 0);
      sc.clip = clip; sc.pick = { id: hit.id, approx: ap, source };
      log(`  🎬 сцена ${idx + 1}: клип от ${source === 'pexels' ? 'Pexels' : 'Pixabay'} по запросу «${q}» → id ${hit.id}`);
      seen.add(hit.id); this._thumb_tick++;
      return { ok: true, note: '', approx: ap, thumb: `temp/scene_${idx}_thumb.jpg?t=${this._thumb_tick}` };
    } catch (e) { continue; }
  }
  return { ok: false, msg: this._t('ai_empty') };
};
Api._hit_thumb_url = function (h) {
  const vids = h.videos || {};
  for (const sz of ['tiny', 'small', 'medium', 'large']) { const t = (vids[sz] || {}).thumbnail; if (t) return t; }
  return h.thumb || h.thumbnail || h.userImageURL || '';
};
P._hit_thumb_url = Api._hit_thumb_url;
// ~20 хитов выбранного банка (тот же путь, что scene_swap_clip)
P._swap_fetch_hits = async function (source, q) {
  if (source === 'pexels') {
    try { return Api._pexels_hits_as_pixabay(await this._pexels_call('pexels_videos', q, 20)); }
    catch (e) { log(`  ⚠ Медиа 1 (Pexels): ${String(e.message || e).slice(0, 50)}`); return []; }
  }
  if (source === 'wikimedia') return await _wikimedia_search(q, 20);
  return await this._pixabay_video_hits(q, false);
};
P.scene_swap_candidates = async function (idx, source = 'pexels') {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  if (!['pexels', 'pixabay', 'wikimedia'].includes(source)) source = 'pexels';
  if (source === 'pexels' && !this.pexels_key) return { ok: false, msg: this._t('m1_no_key') };
  if (source === 'pixabay' && !this.pixabay_keys.length) return { ok: false, msg: this._t('m2_no_key') };
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  let st = this._scene_swap_state[idx];
  if (!st || st.source !== source || st.q !== q) { st = { source, q, hits: await this._swap_fetch_hits(source, q), offered: [] }; this._scene_swap_state[idx] = st; }
  if (!st.hits.length) return { ok: false, msg: this._t({ pexels: 'm1_empty', pixabay: 'm2_empty', wikimedia: 'wiki_empty' }[source] || 'm2_empty') };
  const busy = new Set(this._scene_used_ids(idx)); const _cur = (sc.pick || {}).id; if (_cur != null) busy.add(_cur);
  const sk = `${source}:${q}`; const seen = (this._swap_seen[sk] = this._swap_seen[sk] || new Set());
  const add_n = st.offered.length ? 1 : 3; let added = 0;
  for (const h of st.hits) {
    if (added >= add_n) break;
    const hid = h.id; if (hid == null || st.offered.includes(hid) || busy.has(hid)) continue;
    st.offered.push(hid); seen.add(hid); added++;
  }
  const by_id = new Map(st.hits.map(h => [h.id, h]));
  return { ok: true, candidates: st.offered.map(hid => ({ id: hid, source, thumb: Api._hit_thumb_url(by_id.get(hid) || {}) })), exhausted: added === 0, source };
};
P.scene_source_probe = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const sc = this.reel_scenes[idx]; if (sc.cta) return { ok: false };
  const q = sc.query || 'background';
  const cache = (this._src_probe_cache = this._src_probe_cache || {});
  if (q in cache) return Object.assign({ ok: true }, cache[q]);
  const have_pex = !!this.pexels_key, have_pix = !!this.pixabay_keys.length;
  const res = {}; if (!have_pex) res.pexels = 'nokey'; if (!have_pix) res.pixabay = 'nokey';
  const probe = (src) => this._swap_fetch_hits(src, q).then(r => !!(r && r.length)).catch(() => false);
  const jobs = []; if (have_pex) jobs.push('pexels'); if (have_pix) jobs.push('pixabay'); jobs.push('wikimedia');
  let notdone = false;
  await Promise.all(jobs.map(src => Promise.race([probe(src).then(v => { if (!(src in res)) res[src] = v ? 'has' : 'empty'; }), new Promise(r => setTimeout(() => { if (!(src in res)) { res[src] = 'empty'; notdone = true; } r(); }, 4000))])));
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
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const st = this._scene_swap_state[idx]; if (!st) return { ok: false, msg: this._t('ai_empty') };
  const n = parseInt(hit_id); if (!Number.isNaN(n) && String(n) === String(hit_id)) hit_id = n;
  const hit = st.hits.find(h => h.id === hit_id); if (!hit) return { ok: false, msg: this._t('ai_empty') };
  if (!['pexels', 'pixabay', 'wikimedia'].includes(source)) source = 'pexels';
  const sc = this.reel_scenes[idx]; const q = sc.query || 'background';
  if (source === 'wikimedia') {
    if (!hit.url) return { ok: false, msg: this._t('ai_empty') };
    try {
      const dst = await _dl_clip(idx, hit.url, '.jpg', false);
      sc.clip = dst; sc.pick = { id: hit.id, approx: false, source: 'wikimedia', is_video: false }; sc.locked = true;
      log(`  🏛 сцена ${idx + 1}: Wikimedia (лиц. ${hit.license}) id ${hit.id} по запросу «${q}»`);
      this._thumb_tick++;
      return { ok: true, approx: false, kind: 'image', thumb: `temp/scene_${idx}_thumb.jpg?t=${this._thumb_tick}` };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  }
  const vids = hit.videos || {}; const v = vids.medium || vids.small || vids.tiny || vids.large;
  if (!v || !v.url) return { ok: false, msg: this._t('ai_empty') };
  try {
    const clip = await _dl_clip(idx, v.url);
    const toks = _rel_tokens(this.reel_topic);
    const ap = !!((hit.tags || '').trim() && toks.size && _hit_tag_overlap(hit, toks) === 0);
    sc.clip = clip; sc.pick = { id: hit.id, approx: ap, source }; sc.locked = true;
    log(`  🎬 сцена ${idx + 1}: выбран клип от ${source === 'pexels' ? 'Pexels' : 'Pixabay'} по запросу «${q}» → id ${hit.id}`);
    this._thumb_tick++;
    return { ok: true, approx: ap, thumb: `temp/scene_${idx}_thumb.jpg?t=${this._thumb_tick}` };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.scene_upload_file = function (idx) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
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
// «Своя сборка»: ручная длина сцены (0 = авто по озвучке)
P.scene_set_length = function (idx, secs) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  let v = parseFloat(secs || 0); if (Number.isNaN(v)) v = 0;
  v = v <= 0 ? 0.0 : Math.max(1.0, Math.min(120.0, v));
  this.reel_scenes[idx].manual_len = v;
  return { ok: true, manual_len: v };
};
// «Своя сборка» триммер: отрезок клипа [start, end] (0,0 = весь клип)
P.scene_set_trim = function (idx, start, end) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  let a = Math.max(0.0, parseFloat(start || 0) || 0), b = parseFloat(end || 0) || 0;
  if (b <= a + 0.2) b = 0.0;
  this.reel_scenes[idx].start = a; this.reel_scenes[idx].end_at = b;
  return { ok: true, start: a, end_at: b };
};
// полный сброс рабочего места «Из видео» при смене режима
P.clear_foreign_source = function () {
  this.foreign_audio_path = null; this.foreign_segments = []; this.foreign_cap_zone = null; this._foreign_src_dur = 0;
  try { this.reset_reel(); } catch (e) { }
  this._persist();
  return { ok: true };
};

// свежий клип сцены (id не в used): Pexels-default -> Pixabay-backup, видео -> фото;
// approx=True — релевантного нет ни в одном источнике
P._pixabay_pick = async function (query, used) {
  const key = this.pixabay_key;
  const strong = _rel_tokens(this.reel_topic); const qtoks = _query_content_tokens(query);
  const variants = _query_variants(query, this.reel_topic);
  const specific = new Set(variants.slice(0, C['Api._SPECIFIC_VARIANT_CUTOFF'])); const pexels_first = !!this.pexels_key;
  const MIN = C['Api._SCENE_MIN_CONFIDENT'];
  log(`  🔎 сцена «${(query || '').slice(0, 50)}» → в сток: ${JSON.stringify(variants.slice(0, 4))} | тема «${(this.reel_topic || '').slice(0, 40)}» | порог: ` + (strong.size ? `по теме ${JSON.stringify([...strong].sort())}` : (qtoks.size ? `по ключам сцены ${JSON.stringify([...qtoks].sort())}` : 'ВЫКЛ (нет ни токенов темы, ни ключей запроса)')));
  const _pix_confident = (item) => strong.size ? _hit_tag_overlap(item, strong) > 0 : (qtoks.size ? _hit_tag_overlap(item, qtoks) > 0 : true);
  const confident = []; let fallback = null;
  const _consider = (item, ok) => { if (ok) confident.push(item); else if (fallback === null) fallback = item; return confident.length >= MIN; };
  const _scan_pixabay_video = async () => {
    if (!key) return false;
    for (const v of variants) {
      let hits, lim; try { [hits, lim] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 20, false); } catch (e) { continue; }
      if (lim || !hits || !hits.length) continue;
      for (const c of Api._norm_pixabay_video_hits(_rank_video_hits(hits, '', 0.0, v))) {
        if (used.has(c.id) || !c.url) continue;
        if (_consider({ id: c.id, is_video: true, url: c.url, thumb: c.thumb || '', source: 'pixabay' }, _pix_confident(c))) return true;
      }
      return false;
    }
    return false;
  };
  const _scan_pexels_video = async () => {
    if (!this.pexels_key) return false;
    for (const v of variants) {
      let pex; try { pex = await this._pexels_call('pexels_videos', v, 20); } catch (e) { pex = []; }
      if (!pex || !pex.length) continue;
      const vspec = specific.has(v);
      for (const c of pex) { if (used.has(c.id) || !c.url) continue; if (_consider({ id: c.id, is_video: true, url: c.url, thumb: c.thumb || '', source: 'pexels' }, vspec)) return true; }
      return false;
    }
    return false;
  };
  if (pexels_first) { if (!(await _scan_pexels_video())) await _scan_pixabay_video(); }
  else { if (!(await _scan_pixabay_video())) await _scan_pexels_video(); }
  if (confident.length < MIN && key) {
    for (const v of variants) {
      let hits, limited; try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, v, 20, true); } catch (e) { continue; }
      if (limited || !hits || !hits.length) continue;
      for (const h of hits) {
        if (used.has(h.id)) continue;
        const url = h.largeImageURL || h.webformatURL; if (!url) continue;
        if (_consider({ id: h.id, is_video: false, url, thumb: h.webformatURL || h.previewURL || url, source: 'pixabay' }, _pix_confident(h))) break;
      }
      if (confident.length >= MIN) break;
    }
  }
  if (confident.length >= MIN) { const c = confident[0]; log(`     ✓ взят ${c.source} ${c.is_video ? 'видео' : 'фото'} id ${c.id} (релевантный по порогу)`); return c; }
  const wm = await this._wikimedia_pick(query, used);
  if (wm) { log(`     🏛 Wikimedia (архив, лиц. ${wm.license}) id ${wm.id} — взят как запасной (Pexels/Pixabay без релевантного)`); return wm; }
  if (fallback !== null) { fallback.approx = true; log(`     ⚠ релевантного нет — FALLBACK ${fallback.source} ${fallback.is_video ? 'видео' : 'фото'} id ${fallback.id} (approx, НЕ строго в теме)`); return fallback; }
  log('     ✖ ничего не нашлось — сцена пустая');
  return null;
};
// метод цепочки Pexels ('pexels_videos'/'pexels_photos') с ротацией ключей при лимите
P._pexels_call = async function (method, query, per_page = 20) {
  const n = Math.max(1, (this.pexels_keys || [1]).length);
  for (let i = 0; i < n; i++) {
    const chain = this._media_chain(); let res;
    try { res = await chain[method](query, per_page); } catch (e) { res = []; }
    if ((res && res.length) || !chain.pexels_limited) return res || [];
    if (!this._pexels_advance()) return res || [];
  }
  return [];
};
P._pexels_vids = function (query, per_page = 20) { return this._pexels_call('pexels_videos', query, per_page); };
// Pexels-клипы -> форма Pixabay-хита (videos.medium.url)
Api._pexels_hits_as_pixabay = function (clips) {
  return (clips || []).map(c => ({ id: c.id, videos: { medium: { url: c.url, thumbnail: c.thumb || '', width: c.w || 0, height: c.h || 0 } } }));
};
P._pexels_hits_as_pixabay = Api._pexels_hits_as_pixabay;
// видео-хиты Pixabay по вариантам запроса с ротацией ключей; pexels_fallback=false — строго Pixabay
P._pixabay_video_hits = async function (query, pexels_fallback = true) {
  const keys = this.pixabay_keys;
  const dom = _topic_domain(this.reel_topic) || _topic_domain(query);
  const want = this._avg_scene_dur();
  if (keys.length) {
    for (const v of _query_variants(query, this.reel_topic)) {
      for (let off = 0; off < keys.length; off++) {
        const key = keys[(this.pixabay_idx + off) % keys.length]; if (!key) continue;
        let hits, limited;
        try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v || 'background', 20, false); }
        catch (e) { log(`  ⚠ поиск клипов не удался: ${e.message || e}`); return []; }
        if (limited) continue;
        if (hits && hits.length) return _rank_video_hits(hits, dom, want, query);
        break;
      }
    }
  }
  if (pexels_fallback && this.pexels_key) {
    try {
      const pex = await this._pexels_call('pexels_videos', query, 20);
      if (pex.length) { log(`  🔁 клипы с Pexels для «${query}» (${pex.length})`); return _rank_video_hits(Api._pexels_hits_as_pixabay(pex), dom, want, query); }
    } catch (e) { log(`  ⚠ Pexels: ${String(e.message || e).slice(0, 50)}`); }
  }
  return [];
};
// сырые видео-хиты Pixabay -> нормализованные клипы (с w/h)
Api._norm_pixabay_video_hits = function (hits) {
  const out = [];
  for (const h of hits || []) {
    const vids = h.videos || {}; const vv = vids.medium || vids.small || vids.tiny || vids.large || {};
    const u = vv.url; if (!u) continue;
    let thumb = ''; for (const sz of ['medium', 'small', 'large', 'tiny']) { thumb = (vids[sz] || {}).thumbnail; if (thumb) break; }
    if (!thumb) { const pid = h.picture_id; thumb = h.userImageURL || (pid ? `https://i.vimeocdn.com/video/${pid}_295x166.jpg` : ''); }
    out.push({ id: h.id, is_video: true, url: u, thumb, source: 'pixabay', tags: h.tags || '', w: vv.width || 0, h: vv.height || 0 });
  }
  return out;
};
P._norm_pixabay_video_hits = Api._norm_pixabay_video_hits;
// жёлтый баннер, если за прогон был лимит Pixabay (429)
P._emit_pix_limit = function () { if (!PIX.LIMIT_HIT) return; call_js('reelLimit', this._t(this.pexels_key ? 'pix_switch_pexels' : 'pix_limit_note')); };
P._wikimedia_pick = async function (query, used) { used = used || new Set(); for (const c of await _wikimedia_search(query, 20)) if (!used.has(c.id)) return c; return null; };
P._avg_scene_dur = function () { const n = Math.max(1, (this.reel_scenes || []).filter(s => (s.text || '').trim() && !s.cta).length); return Number(this.reel_seconds || 30) / n; };
P._scene_used_ids = function (skip = null) { const s = new Set(); this.reel_scenes.forEach((x, j) => { if (j !== skip && x.pick && x.pick.id) s.add(x.pick.id); }); return s; };
P._media_chain = function () {
  const sig = this.pexels_key;
  if (!this._media_chain_obj || this._media_chain_sig !== sig) { this._media_chain_obj = new MediaProviderChain(this.pexels_key, null, log); this._media_chain_sig = sig; }
  return this._media_chain_obj;
};
// каждая сборка/генерация — с ключа №1 (позиция не персистится)
P._reset_key_rotation = function () { this.pixabay_idx = 0; this.pexels_idx = 0; this.eleven_idx = 0; this.gemini_idx = 0; this.claude_idx = 0; this._media_chain_obj = null; };
P._pexels_advance = function () { const n = (this.pexels_keys || []).length; if (n <= 1) return false; this.pexels_idx = (this.pexels_idx + 1) % n; this._media_chain_obj = null; log(`  ↩ Pexels ключ → #${this.pexels_idx + 1}/${n} (лимит/отказ предыдущего)`); return true; };

P.scene_previews_all = async function () {
  if (this._is_foreign_src_mode()) {
    const n = this.reel_scenes.length; const out = [];
    for (let i = 0; i < n; i++) { const s = this.reel_scenes[i]; const thumb = await this._foreign_src_thumb(i, n); s.preview = thumb; s.pick = null; out.push({ i, thumb, is_video: true }); }
    return { previews: out };
  }
  const used = new Set(); for (const s of this.reel_scenes) if (s.pick && s.pick.id) used.add(s.pick.id);
  const out = [];
  for (let i = 0; i < this.reel_scenes.length; i++) {
    const s = this.reel_scenes[i];
    if (s.clip) { out.push({ i, thumb: this._scene_thumb_url(i, s) }); continue; }
    if (!s.pick) {
      const pick = await this._pixabay_pick(s.query || 'background', used);
      if (pick) { used.add(pick.id); s.preview = pick.thumb; s.pick = pick; } else s.preview = '';
    }
    out.push({ i, thumb: s.preview || '', approx: !!((s.pick || {}).approx), is_video: !!((s.pick || {}).is_video ?? true) });
  }
  return { previews: out };
};
P.scene_preview = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const s = this.reel_scenes[idx];
  if (this._is_foreign_src_mode()) { const thumb = await this._foreign_src_thumb(idx, this.reel_scenes.length); s.preview = thumb; s.pick = null; return { ok: true, thumb, is_video: true }; }
  if (s.clip) return { ok: true, thumb: this._scene_thumb_url(idx, s) };
  if (s.pick) return { ok: true, thumb: s.preview || '' };
  const pick = await this._pixabay_pick(s.query || 'background', this._scene_used_ids(idx));
  if (pick) { s.preview = pick.thumb; s.pick = pick; return { ok: true, thumb: pick.thumb, approx: !!pick.approx, is_video: !!(pick.is_video ?? true) }; }
  return { ok: false, thumb: '' };
};
P.scene_reload_preview = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false, msg: this._t('bad_scenario') };
  const s = this.reel_scenes[idx];
  if (s.cta) return { ok: false, msg: this._t('bad_scenario') };
  if (s.clip) return { ok: true, thumb: this._scene_thumb_url(idx, s) };
  if (!(this.pixabay_key || this.pexels_key)) return { ok: false, msg: this._t('stock_key_needed') };
  s.pick = null; s.preview = '';
  const pick = await this._pixabay_pick(s.query || 'background', this._scene_used_ids(idx));
  if (pick) { s.preview = pick.thumb; s.pick = pick; return { ok: true, thumb: pick.thumb, approx: !!pick.approx, is_video: !!(pick.is_video ?? true) }; }
  return { ok: false, thumb: '' };
};
P._pixabay_play_url = async function (query) {
  const key = this.pixabay_key; if (!key) return [null, ''];
  const variants = _query_variants(query, this.reel_topic);
  for (const v of variants) { try { const [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, 12, false); if (limited || !hits || !hits.length) continue; const vids = hits[0].videos || {}; const u = (vids.medium || vids.small || vids.tiny || vids.large || {}).url; if (u) return ['video', u]; } catch (e) { } }
  for (const v of variants) { try { const [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, v, 12, true); if (limited || !hits || !hits.length) continue; const h = hits[0]; return ['image', h.largeImageURL || h.webformatURL || '']; } catch (e) { } }
  return [null, ''];
};
P.scene_play = async function (idx) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: false };
  const s = this.reel_scenes[idx];
  // кадры исходника: реальный отрезок исходного видео этой сцены
  if (!s.clip && this._is_foreign_src_mode()) {
    const src = this.foreign_audio_path || '';
    if (src && vfs.exists(src)) {
      try {
        const { mediaDur } = await import('./frames.js');
        const { renderSegment } = await import('./engine.js');
        const n = Math.max(1, this.reel_scenes.length);
        const dur = (await mediaDur(src)) || 0.0;
        const usable = Math.max(0.5, dur - Number(this.foreign_tail_trim || 3) - 0.3);
        const frac = n > 1 ? (0.08 + 0.84 * (idx / (n - 1))) : 0.5;
        const at = Math.max(0.0, Math.min(usable, usable * frac));
        const seg_len = Math.min(6.0, Math.max(2.5, usable / n));
        const blur = (this.foreign_fit || 'blur') === 'blur' && !this.foreign_hide_caps;
        const out = `temp/scene_play_${idx}.mp4`;
        const blob = await renderSegment(vfs.read(src), at, seg_len, { blur, zoom: !blur && !!this.foreign_hide_caps });
        vfs.write(out, blob); await vfs.flush(out);
        this._thumb_tick++;
        return { ok: true, kind: 'video', url: `temp/scene_play_${idx}.mp4?t=${this._thumb_tick}` };
      } catch (e) { log(`  ⚠ проигрыш кадра исходника не собрался: ${String(e.message || e).slice(0, 60)}`); }
    }
  }
  const clip = s.clip;
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
