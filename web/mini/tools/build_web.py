# -*- coding: utf-8 -*-
"""Собирает web/index.html из ТОГО ЖЕ интерфейса десктопного Мини (index.html),
подкладывая вместо pywebview JS-бэкенд (vr/*.js). Интерфейс не переписываем."""
import io, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\video_factory_МИНИ\index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
s = io.open(SRC, encoding="utf-8").read()
SHIM = """<script type="module" src="./vr/app.js"></script>
"""
# --- точечные правки интерфейса для веба (минимум, всё остальное — как в программе) ---
UI_PATCHES = [
    # триал: для клипов годится ЛЮБОЙ ключ видео (Pixabay или Pexels), как и в самой сборке
    ("if(r&&r.pixabay){ next(); }", "if(r&&(r.pixabay||r.pexels)){ next(); }"),
    # триал: ключ клипов — Pixabay ИЛИ Pexels (одно поле, тип определяется сам)
    ("trial_need_px:['⬆ Сначала вставь ключ Pixabay в поле шага 1.'", "trial_need_px:['⬆ Сначала вставь ключ Pixabay или Pexels в поле шага 1.'"),
    ("trial_px_bad:['Ключ Pixabay неверный — проверь и вставь заново.'", "trial_px_bad:['Ключ не подходит ни к Pixabay, ни к Pexels — проверь и вставь заново.'"),
    ("trial_px_step:['Ключ Pixabay (клипы) — бесплатный, ~2 минуты. Зайди на сайт → зарегистрируйся → открой страницу API → скопируй ключ из блока «Your API key»:'",
     "trial_px_step:['Ключ видео (клипы): Pixabay ИЛИ Pexels — любой один, бесплатно, ~2 минуты. Зайди на сайт → зарегистрируйся → скопируй API-ключ и вставь сюда:'"),
    ('<input type="password" id="licTrialPxKey" class="fld" style="flex:1" placeholder="Pixabay Key" autocomplete="off">',
     '<input type="password" id="licTrialPxKey" class="fld" style="flex:1" placeholder="Pixabay или Pexels Key" autocomplete="off">'),
    ("""<button class="btn ghost" onclick="api('open_pixabay_signup')" data-i18n="trial_px_get">🔑 Получить ключ Pixabay</button>""",
     """<button class="btn ghost" onclick="api('open_pixabay_signup')" data-i18n="trial_px_get">🔑 Получить ключ Pixabay</button> <button class="btn ghost" onclick="api('open_pexels_signup')">🔑 Получить ключ Pexels</button>"""),
    # «Галерея» -> в браузере скачивание готового ролика
    ("open_gallery:['📁 Галерея','📁 Gallery']", "open_gallery:['⬇ Скачать ролик','⬇ Download reel']"),
    ("title_open_gallery:['Открыть папку с готовыми рилсами','Open the folder with finished reels']", "title_open_gallery:['Скачать готовый ролик (MP4) на устройство','Download the finished reel (MP4)']"),
    # видео справа: якорь может быть не в правой колонке (ролик собран не с экрана «Один рилс»)
    ("if(anchor)R.insertBefore(box,anchor); else R.appendChild(box);", "if(anchor&&anchor.parentNode===R)R.insertBefore(box,anchor); else R.appendChild(box);"),
    # «Галерея» (папка output) в браузере = скачать ролик
    ("open_folder:['📁 Папка output','📁 output folder']", "open_folder:['⬇ Скачать ролик','⬇ Download reel']"),
]
for a, b in UI_PATCHES:
    assert s.count(a) >= 1, a
    s = s.replace(a, b)
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
