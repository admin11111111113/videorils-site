// Порт Api (Лайт): «Пакет» / «Сделать серию» — генерация N роликов по темам, превью пакета с
// правкой каждого ролика в обычной раскадровке, сборка одобренного превью, авто-ретрай ИИ.
import { C, log, re, call_js, sleep, strftime, path, choice, vfs, _build_log_open, _build_log_close } from './core.js';
import { makeThumb } from './thumbs.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const { REEL_TYPES, STYLES } = C;
const BUNDLE = C['Api._BATCH_BUNDLE_KEYS'], SCENE_METHODS = new Set(C['Api._BATCH_SCENE_METHODS']);
const clone = (x) => (x === undefined || x === null) ? x : structuredClone(x);

Api._slug = function (text) { const s = String(text || '').trim().replace(/[^\p{L}\p{N}_Ѐ-ӿ]+/gu, '_'); return (s.replace(/^_+|_+$/g, '').slice(0, 30) || 'reel'); };
P._slug = Api._slug;
P.estimate_batch = function (topics_text) { const topics = String(topics_text || '').split('\n').map(l => l.trim()).filter(Boolean); return { count: topics.length, provider: this.ai_provider, free: this.ai_provider === 'gemini' }; };
// префикс [тип] из темы: «[топ] города» -> ['города','top']
P._batch_topic_type = function (topic) {
  const m = /^\s*\[([^\]]+)\]\s*(.+)$/s.exec(topic || '');
  if (m) { const key = C['Api._TYPE_ALIASES'][m[1].trim().toLowerCase()]; if (key) return [m[2].trim(), key]; }
  return [topic, null];
};
P._type_ru = function (k) { return Api._type_ru(k); };
P._classify_topic = async function (topic) {
  const prompt = `Определи лучший формат для короткого вертикального рилса на тему «${topic}». Варианты (верни РОВНО одно слово-ключ):\nstory — личная история с интригой\ntop — рейтинг/список/подборка\nuseful — лайфхак/гайд/практическая польза\nhype — шок-факты, вау-эффект\nmoney — заработок/деньги/бизнес\nОтвет — ОДНО слово из: story, top, useful, hype, money.`;
  const [ok, out] = await this._ai_call(prompt, null, 64);
  if (ok) { const w = (out || '').trim().toLowerCase(); for (const k of ['story', 'top', 'useful', 'hype', 'money']) if (w.includes(k)) return k; }
  return null;
};
// формат СРАЗУ для всех тем одним запросом (None где не смог)
P._classify_topics = async function (topics) {
  const keys = ['story', 'top', 'useful', 'hype', 'money']; const res = topics.map(() => null);
  if (!topics.length) return res;
  const numbered = topics.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = 'Для КАЖДОЙ пронумерованной темы выбери лучший формат вертикального рилса.\nstory — личная история с интригой\ntop — рейтинг/список/подборка\nuseful — лайфхак/гайд/практическая польза\nhype — шок-факты, вау-эффект\nmoney — заработок/деньги/бизнес\n\nВерни РОВНО столько же строк вида «номер. ключ» (ключ — ОДНО слово из списка). Без пояснений.\n\nТЕМЫ:\n' + numbered;
  let ok, out; try { [ok, out] = await this._ai_call(prompt, null, Math.min(500, 20 * topics.length + 80)); } catch (e) { return res; }
  if (!ok || !out) return res;
  for (const ln of out.split('\n')) {
    const m = /^\s*(\d+)[.)]\s*([A-Za-zА-Яа-я]+)/.exec(ln);
    if (m) { const idx = parseInt(m[1]) - 1; const w = m[2].trim().toLowerCase(); if (idx >= 0 && idx < res.length) for (const k of keys) if (w.includes(k)) { res[idx] = k; break; } }
  }
  return res;
};
P._batch_checks = function (topics_text) {
  if (this.busy) return [null, { ok: false, msg: this._t('already_processing') }];
  if (!this._has_access()) return [null, { ok: false, need_license: true, msg: this._t('lic_need') }];
  const topics = String(topics_text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!topics.length) return [null, { ok: false, msg: this._t('batch_need_topics') }];
  if (!(this.claude_key || this.gemini_key)) return [null, { ok: false, msg: this._t('ai_no_key') }];
  if (!this._has_stock()) return [null, { ok: false, msg: this._t('stock_key_needed') }];
  if (this.tts_engine === 'myvoice') return [null, { ok: false, msg: this._t('batch_no_myvoice') }];
  return [topics, null];
};
P.build_batch = function (topics_text, type_mode, diff_style) {
  const [topics, err] = this._batch_checks(topics_text); if (err) return err;
  if (!['ai', 'rotate', 'single', 'manual'].includes(type_mode)) type_mode = 'ai';
  this._batch_worker(topics, type_mode, !!diff_style);
  return { ok: true, total: topics.length };
};
// временный сбой ролика (стоит повторить): 5xx, лимит/rate, таймаут, пустой сценарий
P._batch_retryable = function (err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  for (const p of [this._t('ai_bad_key'), this._t('ai_no_funds'), this._t('ai_model_unavailable', '')]) {
    const core = String(p || '').split('—')[0].split('.')[0].trim().toLowerCase().slice(0, 22);
    if (core && m.includes(core)) return false;
  }
  try { if (this._is_ai_limit(String((err && err.message) || err))) return true; } catch (e) { }
  return ['не отвеча', 'не отвечает', 'минуту', 'лимит', 'rate', 'quota', 'timeout', 'таймаут', 'пустой сценарий', 'overload', '503', '500', '502', '504', 'temporar'].some(k => m.includes(k));
};
// ОДИН сценарий пакета (тип -> промпт -> ИИ -> сцены); общая для сборки и превью
P._batch_gen_scenario = async function (topic, i, total, type_mode, diff_style, orig_scenario, types, ai_plan) {
  this._reset_key_rotation();
  let forced; [topic, forced] = this._batch_topic_type(topic);
  this._series_next_ending = '';
  try { const ser = this._series || []; if (ser.includes(topic) && ser.indexOf(topic) < ser.length - 1) this._series_next_ending = ser[ser.indexOf(topic) + 1]; } catch (e) { }
  const in_series = !!(this._series && this._series.length) && this._series.includes(topic);
  if (in_series) { this.reel_scenario = 'story'; log(`  🧩 серия — тип «${this._type_ru('story')}» на все эпизоды (тема доминирует, шаблон типа не перехватывает)`); }
  else if (type_mode === 'manual' && forced) this.reel_scenario = forced;
  else if (type_mode === 'ai') {
    if (ai_plan[i]) { this.reel_scenario = ai_plan[i]; log(`  🔒 проверенный формат «${this._type_ru(ai_plan[i])}» для темы «${topic.slice(0, 40)}»`); }
    else { const chosen = await this._classify_topic(topic); if (chosen) { this.reel_scenario = chosen; log(`  🤖 AI выбрал тип «${this._type_ru(chosen)}» для темы «${topic.slice(0, 40)}»`); } else this.reel_scenario = orig_scenario; }
  } else if (type_mode === 'rotate') this.reel_scenario = types[i % types.length];
  else this.reel_scenario = orig_scenario;
  const style_idx = diff_style ? (this.reel_style + i) % STYLES.length : this.reel_style;
  this.reel_source = 'scratch'; this._session_hooks = [];
  log(`━━ Рилс ${i + 1}/${total} — тема: «${topic.slice(0, 50)}» (формат: ${this._type_ru(this.reel_scenario)}) ━━`);
  log('  ✍️ генерю сценарий строго по этой теме…');
  let prompt = this.get_reel_prompt(topic, false);
  if (this.ai_provider === 'gemini' || (!this.claude_key && this.gemini_key)) prompt = prompt + C['Api._GEM_STRICT'];
  prompt = prompt + this._stress_merge_suffix();
  let [ok, out] = await this._ai_call(prompt);
  if (!ok) { if (this._is_ai_limit(out)) this._notify_ai_limit(); throw new Error(out); }
  out = await this._enforce_char_limit(prompt, out);
  this.parse_to_scenes(out);
  this._apply_scenes_for_build();
  if (!this.reel_phrases.length) throw new Error(this._t('empty_script'));
  log(`  ✅ тема «${topic.slice(0, 36)}» → 1-я фраза: «${this.reel_phrases[0].slice(0, 60)}»`);
  return [topic, style_idx, out];
};
function aiPlan(type_mode, total) {
  const plan = new Array(total).fill(null);
  if (type_mode === 'ai' && total >= 3) {
    const proven = ['hype', 'money']; const n_proven = Math.min(2, total - 1);
    const idx = [...Array(total).keys()]; for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]]; }
    const picks = idx.slice(0, n_proven).sort((a, b) => a - b);
    picks.forEach((pos, j) => { plan[pos] = proven[j % proven.length]; });
    return [plan, n_proven, proven];
  }
  return [plan, 0, []];
}
async function batchThumb(api, p, n) {
  try { await makeThumb(p, `temp/batch_thumb_${n}.jpg`, 200); api._thumb_tick++; return `temp/batch_thumb_${n}.jpg?t=${api._thumb_tick}`; } catch (e) { return ''; }
}
P._batch_worker = async function (topics, type_mode, diff_style) {
  this.busy = true; _build_log_open(false, 'batch');
  this._build_piper_override = null; this._build_eleven_override = false; this._edge_build_choice = null;
  this._reel_used_clips = new Set();
  const types = REEL_TYPES.map(t => t[0]).filter(k => k !== 'money');
  const orig_scenario = this.reel_scenario, orig_source = this.reel_source; const saved_hooks = [...this._session_hooks];
  this._batch_results = []; let done = 0; const total = topics.length;
  this._gem_batch_preflight(total);
  const [ai_plan, n_proven, proven] = aiPlan(type_mode, total);
  if (n_proven) log(`▶ Пакет «AI»: ${n_proven} проверенных (${proven.slice(0, n_proven).join(', ')}) + ${total - n_proven} на выбор AI`);
  if (type_mode === 'ai') { const miss = ai_plan.map((v, k) => v === null ? k : -1).filter(k => k >= 0); if (miss.length) { const got = await this._classify_topics(miss.map(k => topics[k])); miss.forEach((k, j) => { if (got[j]) ai_plan[k] = got[j]; }); } }
  try {
    for (let i = 0; i < topics.length; i++) {
      let topic = topics[i];
      call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'work' });
      let p = null, out = '', last_err = null, topic_c = topic;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let style_idx; [topic_c, style_idx, out] = await this._batch_gen_scenario(topic, i, total, type_mode, diff_style, orig_scenario, types, ai_plan);
          const out_name = `${this._slug(topic_c)}_${strftime('%m%d')}_${i + 1}.mp4`;
          p = await this._build_reel_worker(style_idx, true, out_name);
          last_err = null; break;
        } catch (e) {
          last_err = e;
          if (attempt < 2 && this._batch_retryable(e)) {
            const wait = 22 + attempt * 16;
            log(`  ⏳ Рилс ${i + 1}: ИИ временно недоступен (${String(e.message || e).slice(0, 48)}) — авто-повтор ${attempt + 2}/3 через ${wait}с`);
            call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'retry', msg: this._t('batch_retry', attempt + 2, wait) });
            this._reset_key_rotation(); await sleep(wait);
          } else break;
        }
      }
      if (p) {
        topic = topic_c;
        const thumb = await batchThumb(this, p, i + 1);
        this._batch_results.push({ n: i + 1, topic: topic.slice(0, 60), file: path.basename(p), path: p, thumb, script: out, caption: this.reel_caption || '', tags: this.reel_hashtags || '' });
        done++;
        call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'done', file: path.basename(p) });
      } else {
        log(`  ✖ Рилс ${i + 1} не собрался после повторов: ${(last_err && last_err.message) || last_err}`);
        call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'err', msg: String((last_err && last_err.message) || last_err).slice(0, 120) });
      }
      await sleep(4);
    }
    log(`✅ Пакет готов: ${done}/${total} рилсов в папке output`);
    if (done && !this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    call_js('batchDone', { done, total, reels: this._batch_list() });
  } catch (e) {
    log(`✖ Ошибка пакета: ${e.message || e}`);
    call_js('batchDone', { done, total, reels: this._batch_list() });
  } finally {
    this.reel_scenario = orig_scenario; this.reel_source = orig_source; this._session_hooks = saved_hooks;
    this._reel_used_clips = null; this._series_next_ending = ''; this.busy = false; _build_log_close();
  }
};
// пол рассказчика серии — ОДИН раз: явный сигнал в теме, иначе случайно
Api._pick_series_gender = function (theme) {
  const t = String(theme || '').toLowerCase();
  const fem = ['девушк', 'женщин', 'от лица женщины', 'жена ', 'мама', 'мать-', 'в декрет', 'беременн', 'я родила'].some(w => t.includes(w));
  const masc = ['парн', 'мужчин', 'от лица мужчины', 'муж ушёл', 'отец', 'папа', 'служил в армии', 'я женился'].some(w => t.includes(w));
  if (fem && !masc) return 'ж'; if (masc && !fem) return 'м';
  return choice(['м', 'ж']);
};
P._pick_series_gender = Api._pick_series_gender;
// «Сделать серию»: 1 ИИ-запрос делит широкую тему на подтемы-ролики
P.series_split = async function (theme) {
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  theme = String(theme || '').trim();
  if (!theme) return { ok: false, msg: this._t('series_need_theme') };
  this._series_theme = theme; this._series_gender = this._pick_series_gender(theme);
  if (!(this.claude_key || this.gemini_key)) return { ok: false, msg: this._t('ai_no_key'), manual: true };
  const prompt = `Раздели широкую тему «${theme}» на 4 последовательные подтемы для СЕРИИ коротких вертикальных рилсов — по одному ролику на подтему. Подтемы идут в логичном порядке (от простого к сильному), каждая самостоятельна и цепляет. Верни РОВНО 4 строки — по одной короткой теме ролика (3-8 слов) в каждой, без нумерации, кавычек и пояснений.`;
  const [ok, out] = await this._ai_call(prompt, null, 800);
  if (!ok) return { ok: false, msg: out, manual: true };
  let items = [];
  for (const ln of String(out || '').split('\n')) {
    let s = ln.replace(/^\s*\d+[.)\-–:]\s*/, '').trim();
    s = s.replace(/^[«»"'\-•]+|[«»"'\-•]+$/g, '').trim();
    if (s && s.length > 2) items.push(s);
  }
  items = items.slice(0, 5);
  if (items.length < 2) return { ok: false, msg: this._t('series_fail'), manual: true };
  return { ok: true, items };
};
// ПРЕВЬЮ пакета: сценарии+сцены+клипы для всех тем БЕЗ сборки видео
P.batch_preview = function (topics_text, type_mode, diff_style) {
  const [topics, err] = this._batch_checks(topics_text); if (err) return err;
  if (!['ai', 'rotate', 'single', 'manual'].includes(type_mode)) type_mode = 'ai';
  this._batch_preview_worker(topics, type_mode, !!diff_style);
  return { ok: true, total: topics.length };
};
P._batch_preview_worker = async function (topics, type_mode, diff_style) {
  this.busy = true; this._reel_used_clips = new Set();
  const types = REEL_TYPES.map(t => t[0]).filter(k => k !== 'money');
  const orig_scenario = this.reel_scenario, orig_source = this.reel_source; const saved_hooks = [...this._session_hooks];
  this._batch_previews = []; this._batch_active_idx = null;
  const total = topics.length; const [ai_plan] = aiPlan(type_mode, total); const errs = [];
  try {
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'work' });
      let _pv = false, last_err = null, topic_c = topic, style_idx = this.reel_style, out = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          [topic_c, style_idx, out] = await this._batch_gen_scenario(topic, i, total, type_mode, diff_style, orig_scenario, types, ai_plan);
          await this.scene_previews_all();
          _pv = true; last_err = null; break;
        } catch (e) {
          last_err = e;
          if (attempt < 2 && this._batch_retryable(e)) {
            const wait = 22 + attempt * 16;
            log(`  ⏳ Рилс ${i + 1} (превью): ИИ временно недоступен (${String(e.message || e).slice(0, 48)}) — авто-повтор ${attempt + 2}/3 через ${wait}с`);
            call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'retry', msg: this._t('batch_retry', attempt + 2, wait) });
            this._reset_key_rotation(); await sleep(wait);
          } else break;
        }
      }
      if (_pv) {
        const disp = this.get_scenes();
        this._batch_previews.push({ n: i + 1, topic: topic_c, style_idx, scenario: this.reel_scenario, out,
          reel_scenes: clone(this.reel_scenes), reel_topic: this.reel_topic, reel_caption: this.reel_caption, reel_hashtags: this.reel_hashtags,
          reel_scene_picks: clone(this.reel_scene_picks), reel_scene_clips: Object.assign({}, this.reel_scene_clips), reel_images: Object.assign({}, this.reel_images),
          reel_scene_starts: Object.assign({}, this.reel_scene_starts || {}), reel_scene_ends: Object.assign({}, this.reel_scene_ends || {}), reel_phrases: [...this.reel_phrases],
          swap_state: {}, swap_seen: {},
          display: { n: i + 1, topic: topic_c, scenes: disp.scenes || [], caption: disp.caption || '', tags: disp.tags || '' } });
        call_js('batchProgress', { i: i + 1, total, name: topic_c.slice(0, 48), state: 'done' });
      } else {
        const _em = String((last_err && last_err.message) || last_err).slice(0, 160);
        errs.push({ n: i + 1, topic: topic.slice(0, 60), err: _em });
        log(`  ✖ Рилс ${i + 1} (превью) не сгенерился после повторов: ${_em}`);
        call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'err', msg: _em.slice(0, 120) });
      }
      await sleep(2);
    }
    const reels = this._batch_previews.map(b => b.display);
    log(`✅ Превью пакета готово: ${reels.length}/${total} роликов ок` + (errs.length ? `, ${errs.length} с ошибкой` : ''));
    call_js('batchPreviewReady', { ok: true, reels, errors: errs, total });
  } catch (e) {
    log(`✖ Ошибка превью пакета: ${e.message || e}`);
    call_js('batchPreviewReady', { ok: false, msg: String(e.message || e).slice(0, 160), errors: errs });
  } finally {
    this.reel_scenario = orig_scenario; this.reel_source = orig_source; this._session_hooks = saved_hooks;
    this._reel_used_clips = null; this._series_next_ending = ''; this.busy = false;
  }
};
P._batch_capture_active = function (ri) { if (!(ri >= 0 && ri < this._batch_previews.length)) return; const b = this._batch_previews[ri]; for (const [attr, key] of BUNDLE) b[key] = this[attr]; };
P._batch_set_active = function (ri) {
  if (!(ri >= 0 && ri < this._batch_previews.length)) return false;
  const prev = this._batch_active_idx;
  if (prev !== null && prev !== undefined && prev !== ri && prev >= 0 && prev < this._batch_previews.length) this._batch_capture_active(prev);
  const b = this._batch_previews[ri]; for (const [attr, key] of BUNDLE) { const v = b[key]; this[attr] = (v === undefined && this[attr] && typeof this[attr] === 'object') ? (Array.isArray(this[attr]) ? [] : {}) : v; }
  this._batch_active_idx = ri; return true;
};
// правка сцены ролика превью: активируем ролик, зовём обычный scene-метод, синхронизируем бандл
P.batch_scene = async function (reel_idx, method, ...args) {
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  if (!SCENE_METHODS.has(method)) return { ok: false, msg: 'bad method' };
  const ri = parseInt(reel_idx); if (!this._batch_set_active(ri)) return { ok: false, msg: 'bad reel' };
  try { return await this[method](...args); } finally { this._batch_capture_active(ri); }
};
P.batch_preview_open = function (reel_idx) {
  const ri = parseInt(reel_idx); if (!this._batch_set_active(ri)) return { ok: false, msg: 'bad reel' };
  const g = this.get_scenes(); const b = this._batch_previews[ri];
  return { ok: true, n: b.n, topic: b.topic, scenes: g.scenes || [], caption: g.caption || '', tags: g.tags || '' };
};
P.batch_preview_close = function (reel_idx) {
  const ri = parseInt(reel_idx); this._batch_capture_active(ri);
  if (!(ri >= 0 && ri < this._batch_previews.length)) return { ok: false };
  const g = this.get_scenes(); const b = this._batch_previews[ri];
  b.display = { n: b.n, topic: b.topic, scenes: g.scenes || [], caption: g.caption || '', tags: g.tags || '' };
  return { ok: true, reel: b.display };
};
P.build_batch_from_preview = function () {
  if (this.busy) return { ok: false, msg: this._t('already_processing') };
  if (!this._has_access()) return { ok: false, need_license: true, msg: this._t('lic_need') };
  if (!(this._batch_previews && this._batch_previews.length)) return { ok: false, msg: this._t('batch_msg_preview_first') };
  this._batch_build_from_preview_worker();
  return { ok: true, total: this._batch_previews.length };
};
// одобренные сцены (с правками) -> всё, что нужно сборке; выбранные клипы сохраняются
P._prep_preview_scenes = async function () {
  let _voiced = this.reel_scenes.filter(x => x.text.trim()); const _dd = [];
  for (const _s of _voiced) { if (_dd.length && _s.text.trim().toLowerCase() === _dd[_dd.length - 1].text.trim().toLowerCase()) continue; _dd.push(_s); }
  _voiced = this._fit_scenes_to_target(_dd, this.reel_seconds || 0);
  const phrases = _voiced.map(x => x.text.trim()); const spoken = []; this.reel_keep_stress = [];
  for (const _s of _voiced) { const [_m, _ch] = await this._merge_manual_stress(_s.text.trim(), _s.stress, _s.stress_manual); spoken.push(_m); this.reel_keep_stress.push(_ch); }
  const images = {}, highlights = {}, scene_clips = {}, scene_picks = {}, scene_starts = {}, scene_ends = {}; let n = 0;
  for (const s of _voiced) {
    if (!s.text.trim()) continue; n++;
    images[n] = s.query || 'cinematic atmospheric background';
    if (s.kw) highlights[n] = new Set(s.kw.split(/\s+/).filter(Boolean).map(w => w.toUpperCase()));
    if (s.clip && vfs.exists(s.clip)) scene_clips[n] = s.clip;
    if (s.pick) scene_picks[n] = s.pick;
    if (s.start) scene_starts[n] = Number(s.start);
    if (s.end_at) scene_ends[n] = Number(s.end_at);
  }
  Object.assign(this, { reel_phrases: phrases, reel_spoken: spoken, reel_images: images, reel_highlights: highlights, reel_scene_clips: scene_clips, reel_scene_picks: scene_picks, reel_scene_starts: scene_starts, reel_scene_ends: scene_ends, reel_sfx: {}, reel_text: phrases.join(' ') });
  this.reel_scene_lens = _voiced.map(s => Number(s.manual_len || 0) || 0);
  this._has_manual_lens = this.reel_scene_lens.some(x => x > 0);
  return phrases;
};
P._batch_build_from_preview_worker = async function () {
  this.busy = true; this._reel_used_clips = new Set(); _build_log_open(false, 'batch');
  const orig_scenario = this.reel_scenario, orig_source = this.reel_source; const saved_hooks = [...this._session_hooks];
  const previews = [...this._batch_previews]; this._batch_results = []; const total = previews.length; let done = 0;
  try {
    for (let i = 0; i < total; i++) {
      const b = previews[i]; const topic = b.topic || '';
      call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'work' });
      let p = null;
      try {
        this._batch_set_active(i); this._session_hooks = [];
        if (!(await this._prep_preview_scenes()).length) throw new Error(this._t('empty_script'));
        const style_idx = b.style_idx ?? this.reel_style;
        const out_name = `${this._slug(topic)}_${strftime('%m%d')}_${i + 1}.mp4`;
        p = await this._build_reel_worker(style_idx, true, out_name);
        if (p) {
          const thumb = await batchThumb(this, p, i + 1);
          this._batch_results.push({ n: i + 1, topic: topic.slice(0, 60), file: path.basename(p), path: p, thumb, script: b.out || '', caption: this.reel_caption || '', tags: this.reel_hashtags || '' });
          done++;
        }
        call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'done', file: path.basename(p || '') });
      } catch (e) {
        log(`  ✖ Рилс ${i + 1} не собрался: ${e.message || e}`);
        call_js('batchProgress', { i: i + 1, total, name: topic.slice(0, 48), state: 'err', msg: String(e.message || e).slice(0, 120) });
      }
      await sleep(2);
    }
    log(`✅ Пакет готов: ${done}/${total} рилсов в папке output`);
    if (done && !this.licensed) { await this._mark_trial_used(); this.trial_active = false; call_js('trialUsed', {}); }
    call_js('batchDone', { done, total, reels: this._batch_list() });
  } catch (e) {
    log(`✖ Ошибка пакета: ${e.message || e}`);
    call_js('batchDone', { done, total, reels: this._batch_list() });
  } finally {
    this.reel_scenario = orig_scenario; this.reel_source = orig_source; this._session_hooks = saved_hooks;
    this._reel_used_clips = null; this._series_next_ending = ''; this._batch_previews = []; this._batch_active_idx = null; this.busy = false; _build_log_close();
  }
};
P._batch_list = function () { return this._batch_results.map((r, j) => ({ idx: j, n: r.n, topic: r.topic, file: r.file, thumb: r.thumb || '', caption: r.caption || '', tags: r.tags || '' })); };
P.get_batch_results = function () { return { reels: this._batch_list() }; };
// reel_phrases/images/highlights/scene_clips из текущих сцен (пакет — без picks/starts)
P._apply_scenes_for_build = function () {
  const images = {}, highlights = {}, scene_clips = {}; let n = 0;
  for (const s of this.reel_scenes) {
    if (!s.text.trim()) continue; n++;
    images[n] = s.query || 'cinematic atmospheric background';
    if (s.kw) highlights[n] = new Set(s.kw.split(/\s+/).filter(Boolean).map(w => w.toUpperCase()));
    if (s.clip && vfs.exists(s.clip)) scene_clips[n] = s.clip;
  }
  const _voiced = this.reel_scenes.filter(s => s.text.trim());
  this.reel_phrases = _voiced.map(s => s.text.trim()); this.reel_spoken = [...this.reel_phrases];
  this.reel_keep_stress = _voiced.map(() => false);
  this.reel_scene_lens = _voiced.map(s => Number(s.manual_len || 0) || 0); this._has_manual_lens = this.reel_scene_lens.some(x => x > 0);
  Object.assign(this, { reel_images: images, reel_highlights: highlights, reel_scene_clips: scene_clips, reel_scene_picks: {}, reel_scene_starts: {}, reel_sfx: {}, reel_text: this.reel_phrases.join(' ') });
  return this.reel_phrases;
};
