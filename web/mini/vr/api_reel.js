// Порт Api: ai_generate_reel, сценарий/промпт, подпись, эмоция, хук, парсер ответа,
// раскадровка (get_scenes, scene_set_text, _merge_manual_stress) — app.py 8017–8198, 9007–9876.
import { C, log, re, pystrip, pysplit, vfs, sleep } from './core.js';
import { clean_phrase, split_into_phrases, _strip_service_lines } from './textutil.js';
import { _stock_keywords } from './media.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const { REEL_TYPES, REEL_PROMPTS, REEL_PROMPTS_EN, AUTO_PROMPT, AUTO_PROMPT_EN, EMOTIONS, EMOTION_ORDER, SFX_CATEGORIES, _REEL_ENDINGS, _REEL_ENDINGS_EN, _PLACEHOLDER_HEADS, _PLACEHOLDER_TEXTS } = C;
const _GEM_STRICT = C['Api._GEM_STRICT'];
const CYR = /[а-яёА-ЯЁ]/, LAT = /[a-zA-Z]/;

P.ai_generate_reel = async function (story) {
  if (this.reel_source === 'foreign' && this.foreign_audio_path && !(this.foreign_segments || []).map(s => s.text || '').join(' ').trim()) return this.foreign_silent_scenes();
  this._reset_key_rotation();
  let prompt = this.get_reel_prompt(story);
  if (prompt === '__NO_SPEECH__') return { ok: false, code: 'no_speech', msg: this._t('no_speech_or_audio') };
  if (!prompt) return { ok: false, msg: this._t('ai_need_story') };
  if (this.ai_provider === 'gemini' || (!this.claude_key && this.gemini_key)) prompt = prompt + _GEM_STRICT;
  prompt = prompt + this._stress_merge_suffix();
  this._gem_reel_begin();
  let [ok, out] = await this._ai_call(prompt);
  this._gem_reel_end();
  if (!ok) {
    if (this._is_ai_limit(out)) this._notify_ai_limit();
    return { ok: false, msg: out, manual: true, code: this._ai_last_reason, has_claude: !!this.claude_key };
  }
  let topic_drift = false;
  const en = this.video_lang === 'en';
  if (this.reel_source === 'foreign' && this.foreign_rewrite === 'free' && !(this.foreign_addition || '').trim()) {
    const src_txt = this.foreign_segments.map(s => s.text || '').join(' ');
    if (!this._topic_matches(src_txt, out)) {
      log('[reel] тема ушла в сторону — авто-регенерация с усилением');
      const strong = en ? 'STAY STRICTLY ON THE SOURCE TOPIC: your reel\'s topic is the SAME as in the source text below; do NOT change the subject.\n\n' + prompt
        : 'СТРОГО ПО ТЕМЕ ИСХОДНИКА: тема твоего ролика — ТА ЖЕ, что в исходном тексте ниже; НЕ меняй предмет разговора.\n\n' + prompt;
      const [ok2, out2] = await this._ai_call(strong);
      if (ok2) out = out2;
      if (!(ok2 && this._topic_matches(src_txt, out))) { topic_drift = true; log('[reel] тема всё ещё расходится — отдаю флаг topic_drift'); }
    }
  }
  try {
    const target = Number(this._target_sec() || 0);
    if (target > 0) {
      let pred = this._predict_reel_sec(this._parse_reel_answer(out)[0]);
      const _gap = 3.0; const _cl = this._reel_char_limit(Math.trunc(target));
      for (let _try = 0; _try < 2; _try++) {
        if (!(pred && pred < target - _gap)) break;
        log(`[reel] прогноз ${pred.toFixed(0)}с < цель ${target.toFixed(0)}с (допуск ${_gap.toFixed(0)}с) — добор длины, попытка ${_try + 1}/2`);
        const addp = en
          ? prompt + `\n\nYOUR DRAFT IS TOO SHORT (~${pred.toFixed(0)} sec of ${target.toFixed(0)}). REWRITE LONGER: expand each line with specifics (details, numbers, examples) and/or add 1-2 scenes, so the voice-over takes ${Math.trunc(target - 2)}-${Math.trunc(target)} sec, but NOT more than ${_cl} spoken characters (otherwise it'll have to be trimmed). Same output format, same topic.`
          : prompt + `\n\nТВОЙ ЧЕРНОВИК СЛИШКОМ КОРОТКИЙ (~${pred.toFixed(0)} сек из ${target.toFixed(0)}). ПЕРЕПИШИ ДЛИННЕЕ: разверни каждую фразу конкретикой (детали, цифры, примеры) и/или добавь 1-2 сцены, чтобы озвучка заняла ${Math.trunc(target - 2)}-${Math.trunc(target)} сек, но НЕ больше ${_cl} символов произносимого текста (иначе придётся резать). Тот же формат вывода, та же тема.`;
        const [ok3, out3] = await this._ai_call(addp);
        if (!ok3) { log(`[reel] добор НЕ ВЫПОЛНЕН (ИИ не ответил): ${String(out3).slice(0, 90)}`); break; }
        const pred3 = this._predict_reel_sec(this._parse_reel_answer(out3)[0]);
        if (pred3 > pred) { out = out3; pred = pred3; log(`[reel] добор применён → прогноз ${pred3.toFixed(0)}с (цель ${target.toFixed(0)}с)`); }
        else { log(`[reel] добор не помог (прогноз ${pred3.toFixed(0)}с) — оставляю исходный`); break; }
      }
      if (pred && pred < target - _gap) log(`[reel] ⚠ ИТОГОВЫЙ ПРОГНОЗ ${pred.toFixed(0)}с при цели ${target.toFixed(0)}с — недобор ${(target - pred).toFixed(0)}с`);
    }
  } catch (e) { log(`[reel] добор длины пропущен: ${String(e.message || e).slice(0, 50)}`); }
  try {
    const climit = this._reel_char_limit(); let best_len = this._spoken_chars(out);
    if (climit && best_len > climit) {
      const floor = Math.round(climit * 0.95); const cands = []; let done = false;
      for (let attempt = 1; attempt < 3; attempt++) {
        log(`[reel] текст ${best_len} симв > лимит ${climit} — молча ужимаю (попытка ${attempt}/2, целевое окно ${floor}-${climit})`);
        const shortp = en
          ? prompt + `\n\nYOUR DRAFT IS TOO LONG (~${best_len} spoken characters, hard limit ${climit}). REWRITE SHORTER, but DON'T OVERCUT: land in the ${floor}-${climit} spoken-character range. Under ${floor} characters is BAD: the reel will come out noticeably shorter than intended. Cut filler, not meaning. Same output format, same topic, same number of lines or fewer.`
          : prompt + `\n\nТВОЙ ЧЕРНОВИК СЛИШКОМ ДЛИННЫЙ (~${best_len} символов произносимого текста, жёсткий лимит ${climit}). ПЕРЕПИШИ КОРОЧЕ, но НЕ ОБРЕЗАЙ С ЗАПАСОМ: уложись в диапазон ${floor}-${climit} символов произносимого текста. Короче ${floor} символов — ПЛОХО: ролик выйдет заметно короче нужного. Убирай воду, а не смысл. Тот же формат вывода, та же тема, столько же фраз или меньше.`;
        const [ok4, out4] = await this._ai_call(shortp);
        const s4 = ok4 ? this._spoken_chars(out4) : 0;
        if (!ok4 || s4 <= 0) { log(`[reel] попытка ${attempt}/2 не удалась — стоп`); done = true; break; }
        cands.push([s4, out4]);
        if (floor <= s4 && s4 <= climit) { log(`[reel] ужато → ${s4} симв (окно ${floor}-${climit}) ✓`); out = out4; done = true; break; }
        if (s4 < floor) { log(`[reel] ужато СЛИШКОМ сильно: ${s4} симв при поле ${floor} — пробую ещё раз (иначе ролик недоберёт)`); continue; }
        log(`[reel] всё ещё длинно: ${s4} симв > лимита ${climit}`); best_len = s4;
      }
      if (!done) {   // for…else
        const in_win = cands.filter(c => floor <= c[0] && c[0] <= climit), over = cands.filter(c => c[0] > climit);
        if (in_win.length) out = in_win.reduce((a, b) => Math.abs(b[0] - climit) < Math.abs(a[0] - climit) ? b : a)[1];
        else if (over.length) { const m = over.reduce((a, b) => b[0] < a[0] ? b : a); log(`[reel] беру самый короткий из длинных: ${m[0]} симв (перебор подожмётся ускорением)`); out = m[1]; }
        else if (cands.length) { const m = cands.reduce((a, b) => b[0] > a[0] ? b : a); log(`[reel] все варианты ниже поля ${floor}; беру самый длинный: ${m[0]} симв`); out = m[1]; }
      }
    }
  } catch (e) { log(`[reel] лимит длины пропущен: ${String(e.message || e).slice(0, 50)}`); }
  let auto_type = null;
  try {
    const res = this._parse_reel_answer(out);
    if (res[0].length) this._record_hook(res[0][0]);
    if (this.reel_scenario === 'auto') auto_type = Api._norm_type(res[4].type);
  } catch (e) { }
  const result = { ok: true, text: out };
  if (topic_drift) { result.topic_drift = true; result.drift_msg = 'Тема могла уйти в сторону от исходного видео — перегенерировать?'; }
  if (auto_type) { this.reel_auto_type = auto_type; result.auto_type = auto_type; result.auto_type_ru = Api._type_ru(auto_type); }
  return result;
};

// ---- типы сценария ----
P._scenario_types = function () { return REEL_TYPES.map(([k, e, ru, en]) => ({ key: k, emoji: e, ru, en, customized: k in this.custom_prompts })); };
P.get_scenario_state = function () { return { selected: this.reel_scenario, types: this._scenario_types() }; };
P.set_reel_scenario = function (kind) { if (kind in REEL_PROMPTS || kind === 'auto') { this.reel_scenario = kind; this._persist(); } return { ok: true, selected: this.reel_scenario }; };
Api._type_ru = function (key) { const r = REEL_TYPES.find(t => t[0] === key); return r ? r[2] : key; };
Api._norm_type = function (word) {
  const w = (word || '').trim().toLowerCase();
  return ({ story: 'story', 'история': 'story', 'рассказ': 'story', top: 'top', 'топ': 'top', 'рейтинг': 'top', 'список': 'top', useful: 'useful', 'польза': 'useful', 'гайд': 'useful', hype: 'hype', 'хайп': 'hype', 'факты': 'hype', money: 'money', 'деньги': 'money', 'бизнес': 'money' })[w] || null;
};
P.get_prompt_text = function (kind) { if (!(kind in REEL_PROMPTS)) return { ok: false, msg: this._t('bad_scenario') }; return { ok: true, kind, text: this.custom_prompts[kind] ?? REEL_PROMPTS[kind], is_default: !(kind in this.custom_prompts) }; };
P.set_custom_prompt = function () { return { ok: true, customized: false }; };
P.reset_prompt = function (kind) { if (!(kind in REEL_PROMPTS)) return { ok: false, msg: this._t('bad_scenario') }; delete this.custom_prompts[kind]; this._persist(); return { ok: true, text: REEL_PROMPTS[kind] }; };
P._pick_ending = function () { const base = this.video_lang === 'en' ? _REEL_ENDINGS_EN : _REEL_ENDINGS; const i = (this._ending_idx || 0) % base.length; this._ending_idx = i + 1; return base[i]; };
P._speech_rate_factor = function () {
  const eng = this.tts_engine || '';
  try {
    let pct;
    if (eng === 'piper') { const spd = Number(this.piper_speed || 0); const ls = Math.max(0.5, Math.min(1.6, 1.0 - spd / 100.0)); return Math.max(0.5, Math.min(1.6, 1.0 / ls)); }
    else if (eng === 'eleven') return 1.0;
    else { const em = EMOTIONS.calm || {}; pct = Math.max(-40, Math.min(40, Number(this.reel_rate || 0) + (em.edge_rate || 0))); }
    return Math.max(0.5, Math.min(1.6, 1.0 + pct / 100.0));
  } catch (e) { return 1.0; }
};
P._wps = function () { const base = this.video_lang === 'en' ? 2.65 : 2.1; return Math.max(0.5, base * this._speech_rate_factor()); };
P._reel_char_limit = function (secs = null) {
  if (secs === null || secs === undefined) secs = this.reel_seconds || 0;
  try {
    let cps = this.video_lang === 'en' ? C['Api._TTS_CPS_EN'] : C['Api._TTS_CPS'];
    if (this.tts_engine === 'myvoice') cps *= C['Api._MYVOICE_CPS_MARGIN'];
    cps *= this._speech_rate_factor();
    return Math.max(60, Math.round(Number(secs) * cps));
  } catch (e) { return 550; }
};
P._spoken_chars = function (answer) { try { return (this._parse_reel_answer(answer)[0] || []).reduce((a, p) => a + [...p].length, 0); } catch (e) { return 0; } };

P.get_reel_prompt = function (story, anti_repeat = true) {
  let source, text_val;
  if (this.reel_source === 'foreign') {
    source = this.foreign_segments.map(s => s.text.trim()).join(' ').trim();
    if (!source) { log('[reel] foreign: пустой транскрипт — генерация отменена'); return '__NO_SPEECH__'; }
    const add = this.foreign_addition.trim(); const en = this.video_lang === 'en';
    if (add) {
      text_val = en
        ? "Write YOUR OWN vertical reel on a NEW topic (below), using the source video only as a FORMAT TEMPLATE (structure, rhythm, delivery style). Do NOT carry over concrete details of the source - district / place / person / brand names: they belong to the OLD context. All details, places and names must fit the NEW topic. Write in your own words, don't copy verbatim.\n\nNEW TOPIC (the main anchor - subordinate everything to it): " + add + "\n\nSOURCE VIDEO (format template only, NOT the source of topic or details):\n" + source + "\n\nFINAL CHECK: any details (districts, places, names) that 'leaked' from the old topic? Replace them with ones relevant to the new topic - nothing from the old context must remain."
        : 'Напиши СВОЙ вертикальный ролик на НОВУЮ тему (указана ниже), используя исходное видео лишь как ОБРАЗЕЦ ФОРМАТА (структура, ритм, тип подачи). НЕ переноси конкретные детали исходника — названия районов, мест, имён, брендов: они из СТАРОГО контекста. Все детали, места и названия должны соответствовать НОВОЙ теме. Пиши своими словами, не копируй дословно.\n\nНОВАЯ ТЕМА (главный ориентир — подчиняй всё этому): ' + add + '\n\nИСХОДНОЕ ВИДЕО (только образец формата, НЕ источник темы и деталей):\n' + source + '\n\nФИНАЛЬНАЯ ПРОВЕРКА: нет ли деталей (районы, места, имена), «протёкших» из старой темы? Замени все такие на релевантные новой теме — в тексте не должно остаться ничего из старого контекста.';
    } else {
      text_val = en
        ? "The reel's topic MUST be THE SAME as in the source text below: the same subject, the same thing being discussed. Write YOUR OWN reel on THE SAME topic - a different structure, your own wording, your own examples and conclusion, but the topic, subject and essence come from the source. Do NOT copy verbatim and do NOT retell one-to-one - make a fresh, original reel ON THE VERY SAME TOPIC.\n\nSOURCE TEXT (this IS the TOPIC of your reel):\n" + source
        : 'Тема ролика — ОБЯЗАТЕЛЬНО ТА ЖЕ, что в исходном тексте ниже: тот же предмет, та же тема разговора. Напиши СВОЙ ролик на ЭТУ ЖЕ тему — другая структура, свои формулировки, свои примеры и свой вывод, но тема, предмет и суть берутся из исходника. НЕ копируй дословно и НЕ пересказывай один-в-один — сделай свежий оригинальный ролик НА ТУ ЖЕ САМУЮ ТЕМУ.\n\nИСХОДНЫЙ ТЕКСТ (это и есть ТЕМА твоего ролика):\n' + source;
    }
    text_val += en
      ? '\n\nLANGUAGE RULE: the source text above may be in ANY language (often English). Your ENTIRE output must be in natural ENGLISH — TRANSLATE the meaning into English; do NOT keep foreign words and do NOT transliterate them.'
      : '\n\nПРАВИЛО ЯЗЫКА: исходный текст выше может быть на ЛЮБОМ языке (часто на английском). Твой результат — ПОЛНОСТЬЮ на естественном русском: ПЕРЕВЕДИ смысл на русский. НЕ оставляй ни одного английского слова внутри русских фраз и НЕ транслитерируй их кириллицей (никаких «пиньс-саталлит-серверс», «unnecessary apps»).';
  } else {
    source = (story || '').trim();
    if (!source) return '';
    text_val = source;
  }
  if (anti_repeat && this._session_hooks.length) {
    const past = this._session_hooks.slice(-6).map(h => '- ' + h).join('\n');
    text_val = 'УЖЕ БЫЛИ ИСПОЛЬЗОВАНЫ такие заходы в прошлых видео на эту тему:\n' + past + '\nСделай СОВЕРШЕННО ДРУГОЙ рилс — другой хук, другой угол подачи, другие акценты и факты. НЕ повторяй перечисленные заходы и формулировки. Удиви новым взглядом на тему.\n\n' + text_val;
  }
  const secs = Math.round(this._target_sec());
  const en = this.video_lang === 'en';
  const wps = this._wps(); const char_limit = this._reel_char_limit(secs);
  const _CPP = 88; const ASK = C['Api._ASK_MARGIN'];
  const phrases = Math.max(3, Math.min(Math.round(secs / 4.0), Math.round(char_limit * ASK / _CPP)));
  const _cps = en ? C['Api._TTS_CPS_EN'] : C['Api._TTS_CPS'];
  const _cpw = Math.max(3.0, _cps / wps);
  const total_words = Math.max(15, Math.round(Math.min(secs * wps, char_limit / _cpw) * ASK));
  const min_words = Math.max(10, Math.min(Math.round((secs - 3) * wps * ASK), total_words - 5));
  let target_chars = Math.min(Math.trunc(secs * (en ? 14.5 : 14)), char_limit); target_chars = Math.trunc(target_chars * ASK);
  const template = this.reel_scenario === 'auto' ? (en ? AUTO_PROMPT_EN : AUTO_PROMPT) : (this.custom_prompts[this.reel_scenario] ?? (en ? REEL_PROMPTS_EN : REEL_PROMPTS)[this.reel_scenario]);
  const prompt = template.replaceAll('{SECONDS}', String(secs)).replaceAll('{TOTAL_WORDS}', String(total_words)).replaceAll('{MIN_WORDS}', String(min_words))
    .replaceAll('{TARGET_CHARS}', String(target_chars)).replaceAll('{CHAR_LIMIT}', String(Math.trunc(char_limit * ASK))).replaceAll('{PHRASES}', String(phrases))
    .replaceAll('{ENDING}', this._pick_ending()).replaceAll('{TEXT}', text_val);
  try { log(`[reel] src=${this.reel_source} rewrite=${this.foreign_rewrite || '-'} transcript=${source.length}c add=${this.reel_source === 'foreign' ? !!(this.foreign_addition || '').trim() : false} | prompt[:200]=${prompt.slice(0, 200).replace(/\n/g, ' ')}`); } catch (e) { }
  return prompt;
};
P._record_hook = function (first_phrase) { const h = (first_phrase || '').trim(); if (h && !this._session_hooks.includes(h)) { this._session_hooks.push(h); this._session_hooks = this._session_hooks.slice(-8); } };
P.get_reel_publish = function () { return { caption: this.reel_caption, tags: this.reel_hashtags }; };
P.ai_regen_caption = async function () {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  if (!this.reel_phrases.length) return { ok: false, msg: this._t('paste_reel_answer') };
  const en = this.video_lang === 'en';
  const prompt = en
    ? 'Here is the text of a finished vertical reel:\n' + this.reel_phrases.join(' ') + '\n\nCome up with a NEW publishing variant (different from the previous one). Return EXACTLY two lines and nothing else:\nDESC|a catchy post caption (1-2 lines, with intrigue, on the topic)\nTAGS|#tag1 #tag2 #tag3 #tag4 #tag5 (5-7 relevant hashtags)'
    : 'Вот текст готового вертикального рилса:\n' + this.reel_phrases.join(' ') + '\n\nПридумай НОВЫЙ вариант для публикации (отличный от предыдущего). Верни РОВНО две строки и больше ничего:\nDESC|цепляющая подпись для поста (1-2 строки, с интригой, под тему)\nTAGS|#тег1 #тег2 #тег3 #тег4 #тег5 (5-7 релевантных хэштегов)';
  const [ok, out] = await this._ai_call(prompt, null, 800);
  if (!ok) return { ok: false, msg: out, manual: true, code: this._ai_last_reason };
  const meta = this._parse_reel_answer(out)[4];
  this.reel_caption = meta.caption || this.reel_caption; this.reel_hashtags = meta.tags || this.reel_hashtags;
  return { ok: true, caption: this.reel_caption, tags: this.reel_hashtags };
};
P.get_voice_emotion = function () { return { emotion: this.reel_emotion, engine: this.tts_engine, types: EMOTION_ORDER.map(k => ({ key: k, emoji: EMOTIONS[k].emoji, ru: EMOTIONS[k].ru, en: EMOTIONS[k].en })) }; };
P.set_reel_emotion = function (which) { if (which in EMOTIONS) { this.reel_emotion = which; this._persist(); } return { ok: true, emotion: this.reel_emotion }; };
P.ai_hook_variants = async function () {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  let cur = '', topic = '';
  if (this.reel_scenes.length) { cur = this.reel_scenes[0].text; topic = this.reel_scenes.slice(0, 3).map(s => s.text).join(' '); }
  else if (this.reel_phrases.length) { cur = this.reel_phrases[0]; topic = this.reel_phrases.slice(0, 3).join(' '); }
  if (!(cur || topic)) return { ok: false, msg: this._t('ai_need_story') };
  const en = this.video_lang === 'en';
  const t = REEL_TYPES.find(x => x[0] === this.reel_scenario); const ru_name = t ? t[2] : '', en_name = t ? t[3] : '';
  const prompt = en
    ? `Reel type: "${en_name || ru_name}". Reel opening/topic: ${topic}\nCurrent hook (first line): ${cur}\n\nGive 3 DIFFERENT variants of a gripping FIRST line (hook) for this reel — a specific sharp scene + an open loop, 8-16 words, no cliches like "you won't believe". Return EXACTLY 3 lines, each variant on its own line, no numbering, quotes or explanations.`
    : `Рилс типа «${ru_name}». Начало/тема рилса: ${topic}\nТекущий хук (первая фраза): ${cur}\n\nДай 3 РАЗНЫХ варианта цепляющей ПЕРВОЙ фразы (хука) для этого рилса — конкретная острая сцена + недосказанность, 8-16 слов, без клише вроде «вы не поверите». Верни РОВНО 3 строки, каждый вариант с новой строки, без нумерации, кавычек и пояснений.`;
  const [ok, out] = await this._ai_call(prompt, null, 800);
  if (!ok) return { ok: false, msg: out, manual: true, code: this._ai_last_reason };
  const variants = Api._clean_ai_text(out).split('\n').filter(l => l.trim()).map(l => pystrip(l, " -—\"'«»")).slice(0, 3);
  if (!variants.length) return { ok: false, msg: this._t('ai_empty') };
  return { ok: true, variants };
};
P.apply_hook = function (text) { text = (text || '').trim(); if (!text) return { ok: false }; if (this.reel_scenes.length) { this.reel_scenes[0].text = text; this.reel_scenes[0].clip = ''; } return { ok: true }; };
P._sfx_prompt_part = function () {
  if (!this.sfx_enabled || !Object.keys(this._sfx_by_category()).length) return '';
  return 'ДОСТУПНЫЕ ЗВУКИ — добавляй категорию по смыслу фразы (НЕ в каждую, 2-4 на весь рилс, иначе мусор):\n' + SFX_CATEGORIES.map(([c, d]) => `${c} — ${d}`).join('\n') + '\n\n5-е поле |sfx:КАТЕГОРИЯ добавляется ТОЛЬКО если звук уместен. Если не нужен — строка остаётся из 4 полей (например |sfx:money).\n\n';
};
Api._clean_ai_text = function (text) {
  let t = (text || '').replaceAll('\r', '');
  t = t.replace(/```[a-zA-Z]*/g, '').replaceAll('```', '');
  return t.split('\n').map(ln => pystrip(pystrip(ln).replace(/^[*#>\-• ]+/u, '')).replaceAll('**', '')).join('\n');
};
P._clean_ai_text = Api._clean_ai_text;

P._parse_reel_answer = function (text) {
  text = Api._clean_ai_text(text);
  let phrases = []; const images = {}, highlights = {}, sfx = {};
  const en_only = []; let caption = '', tags = '', topic = '', rtype = ''; const stress = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line.includes('|')) continue;
    const parts = line.split('|').map(p => p.trim());
    const head = parts[0].toUpperCase();
    if (['TYPE', 'ТИП', 'FORMAT', 'ФОРМАТ'].includes(head)) { rtype = parts.slice(1).join('|').trim(); continue; }
    if (['TOPIC', 'ТЕМА', 'SUBJECT', 'ПРЕДМЕТ'].includes(head)) { topic = parts.slice(1).join('|').trim(); continue; }
    if (['DESC', 'ОПИСАНИЕ', 'CAPTION', 'ПОДПИСЬ'].includes(head)) { caption = parts.slice(1).join('|').trim(); continue; }
    if (['TAGS', 'ХЭШТЕГИ', 'HASHTAGS', 'ТЕГИ'].includes(head)) { tags = parts.slice(1).join('|').trim(); continue; }
    if (['УД', 'STRESS', 'УДАРЕНИЕ', 'УДАР'].includes(head)) { if (parts.length >= 3 && /^\d+$/.test(parts[1])) stress[parseInt(parts[1])] = parts.slice(2).join('|').trim(); continue; }
    if (_PLACEHOLDER_HEADS.has(head)) continue;
    const is_phrase = head.startsWith('ФРАЗА') || head.startsWith('PHRASE') || head.startsWith('ФРАЗ');
    const body = is_phrase ? parts.slice(1) : parts;
    if (!body.length) continue;
    if (this.video_lang === 'en') {
      const ph = clean_phrase(body[0] || '');
      if (!ph || _PLACEHOLDER_TEXTS.has(ph.trim().toLowerCase())) continue;
      phrases.push(ph); const idx = phrases.length;
      if (body.length > 1 && body[1] && LAT.test(body[1])) images[idx] = _stock_keywords(body[1]);
      if (body.length > 2 && body[2]) { const kw = pystrip(body[2], ' -—.'); if (kw && pysplit(kw).length <= 4) highlights[idx] = new Set(pysplit(kw).map(w => w.toUpperCase())); }
    } else {
      const ru = body.find(f => f && CYR.test(f)) || '';
      if (!ru) { if (is_phrase && body[0]) en_only.push(body); continue; }
      const ph = clean_phrase(ru);
      if (!ph || _PLACEHOLDER_TEXTS.has(ph.trim().toLowerCase())) continue;
      phrases.push(ph); const idx = phrases.length;
      const enq = body.find(f => f && LAT.test(f) && !CYR.test(f)) || '';
      if (enq) images[idx] = _stock_keywords(enq);
      for (const f of body) {
        const w = pystrip(f || '', ' -—.');
        if (w && w !== ru && CYR.test(w) && pysplit(w).length <= 3) { highlights[idx] = new Set(pysplit(w).map(x => x.toUpperCase())); break; }
      }
    }
  }
  if (!phrases.length && en_only.length) {
    for (const body of en_only) {
      const ph = clean_phrase(body[0]);
      if (!ph || _PLACEHOLDER_TEXTS.has(ph.trim().toLowerCase())) continue;
      phrases.push(ph); const idx = phrases.length;
      if (body.length > 1 && body[1] && LAT.test(body[1])) images[idx] = _stock_keywords(body[1]);
    }
  }
  if (!phrases.length) phrases = split_into_phrases(_strip_service_lines(text));
  for (let k = 1; k <= phrases.length; k++) if (!(k in images)) images[k] = 'cinematic atmospheric background';
  return [phrases, images, highlights, sfx, { caption, tags, topic, type: rtype, stress }];
};

// ================= РАСКАДРОВКА =================
P._reset_scene_media = function (drop_locked = true) {
  this._scene_clip_cache = {};
  const pats = [/^temp\/src_r.*\.(mp4|jpg)$/, /^temp\/rclip_.*\.mp4$/];
  if (drop_locked) { this.reel_scene_clips = {}; pats.push(/^temp\/scene_.*_clip\.mp4$/, /^temp\/scene_.*_thumb\.jpg$/); }
  for (const f of vfs.list('temp/')) if (pats.some(p => p.test(f))) vfs.remove(f);
};
Api._norm_phrase = function (s) { return pysplit(re.sub('[^\\w\\s]+', '', (s || '').toLowerCase())); };
P._dedup_phrases = function (phrases, images, highlights) {
  const seen = [], fp = [], fi = {}, fh = {}; let k = 0;
  phrases.forEach((ph, j) => {
    const i = j + 1; const toks = new Set(Api._norm_phrase(ph)); let dup = false;
    for (const s of seen) {
      if (toks.size && toks.size === s.size && [...toks].every(x => s.has(x))) { dup = true; break; }
      if (toks.size >= 3 && s.size) { let inter = 0; for (const x of toks) if (s.has(x)) inter++; const uni = new Set([...toks, ...s]).size; if (uni && inter / uni >= 0.85) { dup = true; break; } }
    }
    if (dup) { log(`  ⚠ дубль фразы убран из раскадровки: «${(ph || '').slice(0, 50)}»`); return; }
    seen.push(toks); k++; fp.push(ph);
    if (images[i]) fi[k] = images[i];
    if (highlights[i]) fh[k] = highlights[i];
  });
  return [fp, fi, fh];
};
P.parse_to_scenes = function (answer) {
  this._content_lang = this.video_lang || 'ru';
  this._reset_scene_media(true);
  let [phrases, images, highlights, sfx, meta] = this._parse_reel_answer(answer);
  [phrases, images, highlights] = this._dedup_phrases(phrases, images, highlights);
  this.reel_caption = meta.caption || ''; this.reel_hashtags = meta.tags || '';
  this.reel_topic = pysplit(meta.topic || '').slice(0, 3).join(' ');
  this.reel_scenes = []; this._swap_seen = {}; this._scene_swap_state = {};
  phrases.forEach((ph, j) => {
    const i = j + 1; const kw = highlights[i] ? [...highlights[i]].sort().join(' ') : '';
    this.reel_scenes.push({ text: ph, orig_text: ph, query: images[i] || '', kw, clip: '', preview: '' });
  });
  const st = meta.stress || {};
  if (Object.keys(st).length && this.el_pronounce) phrases.forEach((ph, j) => { const marked = pystrip(pystrip(st[j + 1] || ''), '"«»'); const raw = (ph || '').trim(); if (raw && marked && marked.length < raw.length * 3) this._pron_cache[raw] = marked; });
  if (phrases.length) this._record_hook(phrases[0]);
  return this.get_scenes();
};
P._scene_thumb_url = function (i, s) {
  const p = `temp/scene_${i}_thumb.jpg`;
  if (s.clip && vfs.exists(p)) return `temp/scene_${i}_thumb.jpg?t=${this._thumb_tick}`;
  return s.preview || '';
};
P._rm_keywords = function (text) { return new Set(re.findall('[а-яёa-z]{4,}', (text || '').toLowerCase()).filter(w => !C['Api._RM_STOP'].has(w))); };
P._text_changed_significantly = function (orig, nw) {
  if ((orig || '').trim() === (nw || '').trim()) return false;
  const a = this._rm_keywords(orig), b = this._rm_keywords(nw);
  if (!a.size) return !!b.size;
  let lost = 0; for (const x of a) if (!b.has(x)) lost++;
  return lost / a.size > 0.5;
};
P._time_scene_bounds = async function (p, seg_sec = 5.0) {
  const { duration } = await import('./audio.js');
  const dur = (await duration(p)) || 0.0;
  if (dur <= 0.3) return [];
  const n = Math.max(2, Math.min(24, Math.round(dur / Math.max(2.0, seg_sec)) || 2));
  const step = dur / n; const bounds = [];
  for (let i = 0; i < n; i++) { const s = Math.round(i * step * 100) / 100; const e = Math.round((i === n - 1 ? dur : (i + 1) * step) * 100) / 100; if (e - s >= 0.2) bounds.push([s, e]); }
  return bounds;
};
P.foreign_silent_scenes = async function () {
  const p = this.foreign_audio_path || '';
  if (!(p && vfs.exists(p))) return { ok: false, msg: this._t('select_audio_first') };
  const bounds = await this._time_scene_bounds(p);
  if (!bounds.length) return { ok: false, msg: this._t('select_audio_first') };
  this.reel_source = 'foreign';
  this.foreign_segments = bounds.map(([s, e]) => ({ start: s, end: e, text: '' }));
  this._reset_scene_media(true);
  this.reel_scenes = bounds.map(([s, e]) => ({ text: '', orig_text: '', query: '', kw: '', clip: '', preview: '', manual_len: Math.round((e - s) * 100) / 100, src_start: s, src_end: e }));
  this.reel_caption = ''; this.reel_hashtags = ''; this.reel_topic = '';
  log(`[reel] немое видео: ${this.reel_scenes.length} сцен по времени (без текста) — впиши текст вручную`);
  const out = this.get_scenes(); out.ok = true; out.silent = true; return out;
};
P.get_scenes = function () {
  return {
    scenes: this.reel_scenes.map((s, i) => ({
      text: s.text, query: s.query, kw: s.kw, thumb: this._scene_thumb_url(i, s), start: s.start || 0, cta: !!s.cta,
      weak: !!((s.pick || {}).weak && !s.clip),
      changed: (!s.cta && !!(s.clip || s.pick) && this._text_changed_significantly(s.orig_text ?? s.text, s.text)),
    })),
    caption: this.reel_caption, tags: this.reel_hashtags, auto_rematch: this.auto_rematch || false,
    outro: { tg: this.outro_tg, site: this.outro_site, bg: this.outro_bg, color: this.outro_color, photo: this.outro_photo || '', show: this.outro_show, enabled: this.outro_on },
  };
};
P.scene_set_text = async function (idx, text) {
  if (!(idx >= 0 && idx < this.reel_scenes.length)) return { ok: true, changed: false };
  const sc = this.reel_scenes[idx];
  sc.text = (text || '').trim(); delete sc.stress; delete sc.stress_manual; delete sc.homographs;
  if (sc.cta) { this.outro_text = sc.text; this._persist(); return { ok: true, changed: false }; }
  const changed = !!(sc.clip || sc.pick) && !sc.locked && this._text_changed_significantly(sc.orig_text || '', sc.text);
  if (changed && this.auto_rematch) { const r = await this.scene_rematch(idx); return { ok: true, changed: false, auto: true, query: r.query || '', scenes: this.get_scenes().scenes }; }
  return { ok: true, changed };
};
P._merge_manual_stress = async function (clean_text, user_stress, manual_idxs = null) {
  const clean = Api._strip_stress(clean_text || ''); const us = user_stress || '';
  if (!us || Api._strip_stress(us) !== clean) return [clean, false];
  const auto = await this._mark_stress(clean);
  const W = '[А-Яа-яЁё́]+';
  const cw = re.findall(W, clean), uw = re.findall(W, us), aw = re.findall(W, auto);
  if (!(cw.length === uw.length && uw.length === aw.length)) return [clean, false];
  const manual = new Set(manual_idxs || []); const out = []; let changed = false;
  cw.forEach((c, i) => { const u = uw[i]; if (u.includes('́') && u.replaceAll('́', '') === c && manual.has(i)) { out.push(u); changed = true; } else out.push(c); });
  if (!changed) return [clean, false];
  let k = 0; return [re.sub(W, () => out[k++], clean), true];
};
