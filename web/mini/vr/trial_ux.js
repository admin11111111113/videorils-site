// Окно бесплатного триала: уже сохранённые ключи показываем как принятые (поля не «пустые»),
// вставленный ключ проверяем сам через секунду (без кнопки).
export function installTrialUX(api) {
  const $ = (id) => document.getElementById(id);
  const say = (el, ok, txt) => { if (!el) return; el.style.color = ok ? 'var(--green)' : 'var(--pink)'; el.textContent = txt; };
  function gemMsgEl() {
    let m = $('licTrialGemMsg'); const inp = $('licTrialGemKey');
    if (!m && inp) { m = document.createElement('div'); m.id = 'licTrialGemMsg'; m.style.cssText = 'font-size:12px;font-weight:700;margin-top:4px'; inp.closest('.row').after(m); }
    return m;
  }
  async function refresh() {
    const px = $('licTrialPxKey'), gk = $('licTrialGemKey'); if (!px || !gk) return;
    const st = await api.get_keys_status();
    if ((st.pixabay || st.pexels) && !px.value.trim()) { px.placeholder = '✅ Ключ видео уже добавлен — вводить не нужно'; say($('licTrialPxMsg'), true, st.pixabay ? '✅ Ключ Pixabay сохранён' : '✅ Ключ Pexels сохранён'); }
    if (st.gemini && !gk.value.trim()) { gk.placeholder = '✅ Ключ Gemini уже добавлен — вводить не нужно'; say(gemMsgEl(), true, '✅ Ключ Gemini сохранён'); }
  }
  function autoCheck(inp, run) {
    let t = null;
    const go = () => { clearTimeout(t); t = setTimeout(run, 900); };
    inp.addEventListener('input', go); inp.addEventListener('paste', () => setTimeout(go, 50));
  }
  function bind() {
    const px = $('licTrialPxKey'), gk = $('licTrialGemKey'); if (!px || px.__vrUx) return; px.__vrUx = true;
    autoCheck(px, async () => {
      const k = px.value.trim(); const m = $('licTrialPxMsg'); if (!k) return;
      say(m, true, '⏳ Проверяю ключ…');
      let [ok] = await api._pixabay_check(k);
      if (ok) { await api.set_pixabay_key(k); say(m, true, '✅ Ключ Pixabay работает'); return; }
      [ok] = await api._pexels_check(k);
      if (ok) { await api.add_pexels_key(k); px.value = ''; refresh(); say(m, true, '✅ Это ключ Pexels — работает, сохранён'); return; }
      say(m, false, '❌ Ключ не подходит — проверь, что скопирован целиком');
    });
    autoCheck(gk, async () => {
      const k = gk.value.trim(); const m = gemMsgEl(); if (!k) return;
      say(m, true, '⏳ Проверяю ключ…');
      const r = await api.check_gemini_key(k);
      if (r.ok || r.state === 'limit') { if (!api.gemini_keys.includes(k)) { api.gemini_keys = [k]; api._persist(); } say(m, true, r.ok ? '✅ Ключ Gemini работает' : '✅ Ключ принят (сейчас лимит Google — подожди минуту)'); }
      else say(m, false, '❌ ' + (r.msg || 'Ключ не подходит'));
    });
  }
  const obs = new MutationObserver(() => { const b = $('licTrialStart'); if (b && b.offsetParent !== null) { bind(); refresh(); } });
  obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
}
