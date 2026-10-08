# -*- coding: utf-8 -*-
"""Собирает web/index.html из ТОГО ЖЕ интерфейса десктопного Мини (index.html),
подкладывая вместо pywebview JS-бэкенд (vr/*.js). Интерфейс не переписываем."""
import io, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\video_factory_МИНИ\index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
s = io.open(SRC, encoding="utf-8").read()
SHIM = """<script type="module">
import { Api } from './vr/api_base.js';
import './vr/api_settings.js';
import './vr/api_voice.js';
const api = new Api();
window.__vrApi = api;
window.pywebview = { api: new Proxy({}, { get: (t, k) => (typeof api[k] === 'function')
  ? (...a) => Promise.resolve().then(() => api[k](...a))
  : (...a) => { console.warn('[web] ещё не перенесено:', k); return Promise.resolve({ ok: false, todo: true }); } }) };
window.dispatchEvent(new Event('pywebviewready'));
</script>
"""
i = s.rindex("</body>")
s = s[:i] + SHIM + s[i:]
s = s.replace("<title>", "<title>Веб · ", 1)
s = s.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', 1)
io.open(OUT, "w", encoding="utf-8").write(s)
print("web/index.html", len(s))
