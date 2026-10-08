# -*- coding: utf-8 -*-
"""Собирает web/index.html из ТОГО ЖЕ интерфейса десктопного Мини (index.html),
подкладывая вместо pywebview JS-бэкенд (vr/*.js). Интерфейс не переписываем."""
import io, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\video_factory_МИНИ\index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
s = io.open(SRC, encoding="utf-8").read()
SHIM = """<script type="module" src="./vr/app.js"></script>
"""
i = s.rindex("</body>")
s = s[:i] + SHIM + s[i:]
s = s.replace("<title>", "<title>Веб · ", 1)
s = s.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', 1)
io.open(OUT, "w", encoding="utf-8").write(s)

# --- copy_assets: те же файлы, что вшиты в сборку (ВидеорилсМини.spec datas) ---
import shutil, json
APP = os.path.dirname(SRC)
WEB = os.path.dirname(OUT)
for rel in ["assets/blogger.png", "assets/preview_big.png",
            "assets/videos/pexels_api_key_guide.mp4", "assets/videos/pixabay_api_key_guide.mp4",
            "assets/videos/elevenlabs_api_key_guide.mp4", "assets/videos/gemini_api_key_guide.mp4"]:
    d = os.path.join(WEB, rel); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy2(os.path.join(APP, rel), d)
sfx_src = os.path.join(APP, "assets", "sfx"); sfx_dst = os.path.join(WEB, "assets", "sfx")
man = {}
for cat in sorted(os.listdir(sfx_src)):
    cp = os.path.join(sfx_src, cat)
    if not os.path.isdir(cp):
        continue
    os.makedirs(os.path.join(sfx_dst, cat), exist_ok=True)
    man[cat] = []
    for f in sorted(os.listdir(cp)):
        if f.lower().endswith((".mp3", ".wav", ".ogg", ".m4a")):
            shutil.copy2(os.path.join(cp, f), os.path.join(sfx_dst, cat, f)); man[cat].append(f)
json.dump(man, io.open(os.path.join(sfx_dst, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("assets ok, sfx:", sum(len(v) for v in man.values()))
print("web/index.html", len(s))
