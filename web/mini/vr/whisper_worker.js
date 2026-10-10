// Распознавание речи (Whisper, transformers.js) в ФОНОВОМ потоке браузера. Раньше модель
// считала прямо в странице: та замирала на секунды, и Chrome предлагал «закрыть страницу».
// Здесь: загрузка модели (кэш браузера — качается 1 раз), автоопределение языка, распознавание.
const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm';
// Телефон: модель small (~250 МБ) слишком тяжёлая — долго и Android закрывает вкладку из-за памяти.
// На телефонах — whisper-base (~77 МБ, ~3× быстрее, чуть хуже качество), на процессоре. ПК — small, как в приложении.
const PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test((self.navigator && navigator.userAgent) || '') || !!(self.navigator && navigator.userAgentData && navigator.userAgentData.mobile);
const MODEL = PHONE ? 'onnx-community/whisper-base_timestamped' : 'onnx-community/whisper-small_timestamped';
let T = null, asr = null;

// Видеокарта (WebGPU) — в разы быстрее процессора. Берём её, только если она умеет fp16
// (тогда модель fp16/q4f16 ~320 МБ); иначе — как раньше, процессор (wasm, q8 ~250 МБ).
async function pickDevice() {
  if (PHONE) return { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
  try {
    if (self.navigator && navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad && ad.features && ad.features.has('shader-f16')) return { device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' } };
    }
  } catch (e) { }
  return { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
}
let DEVICE = 'wasm';
async function load() {
  if (asr) return asr;
  T = await import(TJS);
  const files = {};
  const cfg = await pickDevice();
  const opts = (c) => ({ dtype: c.dtype, device: c.device, progress_callback: prog });
  const prog = (p) => {
      if (p && p.status === 'progress' && p.total) {
        files[p.file] = [p.loaded, p.total];
        const L = Object.values(files).reduce((a, x) => a + x[0], 0), S = Object.values(files).reduce((a, x) => a + x[1], 0);
        self.postMessage({ type: 'progress', frac: S ? L / S : 0 });
      }
    };
  try { asr = await T.pipeline('automatic-speech-recognition', MODEL, opts(cfg)); DEVICE = typeof cfg.device === 'string' ? cfg.device : 'webgpu'; }
  catch (e) {
    if (cfg.device === 'wasm') throw e;
    // видеокарта не поднялась — молча на процессор
    asr = await T.pipeline('automatic-speech-recognition', MODEL, opts({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } })); DEVICE = 'wasm';
  }
  self.postMessage({ type: 'device', device: DEVICE, phone: PHONE });
  return asr;
}

// Автоопределение языка (как faster-whisper: первый токен декодера после <|startoftranscript|>
// на первых 30с). transformers.js без явного языка подставляет английский — поэтому сами.
const WL = ['en','zh','de','es','ru','ko','fr','ja','pt','tr','pl','ca','nl','ar','sv','it','id','hi','fi','vi','he','uk','el','ms','cs','ro','da','hu','ta','no','th','ur','hr','bg','lt','la','mi','ml','cy','sk','te','fa','lv','bn','sr','az','sl','kn','et','mk','br','eu','is','hy','ne','mn','bs','kk','sq','sw','gl','mr','pa','si','km','sn','yo','so','af','oc','ka','be','tg','sd','gu','am','yi','lo','uz','fo','ht','ps','tk','nn','mt','sa','lb','my','bo','tl','mg','as','tt','haw','ln','ha','ba','jw','su'];
async function detect(audio) {
  const tok = asr.tokenizer;
  const tid = (t) => { if (tok.convert_tokens_to_ids) { const v = tok.convert_tokens_to_ids(t); return Array.isArray(v) ? v[0] : v; } const v = tok.encode(t, { add_special_tokens: false }); return v[v.length - 1]; };
  const inp = await asr.processor(audio.slice(0, 16000 * 30));
  const out = await asr.model({ input_features: inp.input_features, decoder_input_ids: new T.Tensor('int64', BigInt64Array.from([BigInt(tid('<|startoftranscript|>'))]), [1, 1]) });
  const lg = out.logits.data; const sc = WL.map(l => [l, lg[tid('<|' + l + '|>')]]).filter(x => Number.isFinite(x[1]));
  const mx = Math.max(...sc.map(x => x[1])); const z = sc.reduce((a, x) => a + Math.exp(x[1] - mx), 0);
  sc.sort((a, b) => b[1] - a[1]);
  return { language: sc[0][0], probability: Math.exp(sc[0][1] - mx) / z };
}

self.onmessage = async (e) => {
  const { id, op, audio, opts } = e.data || {};
  try {
    if (op === 'load') { await load(); self.postMessage({ id, ok: true }); return; }
    await load();
    if (op === 'detect') { self.postMessage({ id, ok: true, result: await detect(audio) }); return; }
    if (op === 'run') {
      const out = await asr(audio, opts || {});
      self.postMessage({ id, ok: true, result: { text: out.text, chunks: (out.chunks || []).map(c => ({ text: c.text, timestamp: c.timestamp })) } });
      return;
    }
    self.postMessage({ id, ok: false, error: 'unknown op ' + op });
  } catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
};
