# -*- coding: utf-8 -*-
"""Собирает web/lite/index.html из ТОГО ЖЕ интерфейса десктопного Лайт (index.html),
подкладывая вместо pywebview JS-бэкенд (vr/*.js). Интерфейс не переписываем."""
import io, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\video_factory_lite\index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
s = io.open(SRC, encoding="utf-8").read()
SHIM = """<script type="module" src="./vr/app.js"></script>
"""
# --- точечные правки интерфейса для веба (минимум, всё остальное — как в программе) ---
UI_PATCHES = [
    # музыка: понятно и для ПК, и для телефона (в вебе файл можно выбрать с любого устройства, папку — только на ПК)
    ("music_choosefile:['🎵 Выбрать файл музыки с ПК','🎵 Choose a music file from PC']",
     "music_choosefile:['🎵 Выбрать музыку с ПК или телефона','🎵 Choose music from PC or phone']"),
    ("music_addfolder:['➕ Добавить папку с музыкой','➕ Add a music folder']",
     "music_addfolder:['➕ Добавить папку с музыкой (на ПК)','➕ Add a music folder (on PC)']"),
    ("music_import:['📥 Забрать из Загрузок','📥 Grab from Downloads']",
     "music_import:['📥 Взять из «Загрузок» (на ПК)','📥 Grab from Downloads (on PC)']"),
    ('data-i18n="music_choosefile">🎵 Выбрать файл музыки с ПК<', 'data-i18n="music_choosefile">🎵 Выбрать музыку с ПК или телефона<'),
    # bust() не трогает ссылки из памяти (blob:) — с «?v=» blob не находится, плеер падал в
    # запасной путь и голос звучал ДВАЖДЫ со сдвигом
    ("function bust(u){return u+(u.indexOf('?')<0?'?':'&')+'v='+Math.floor(Math.random()*1e9);}",
     "function bust(u){if(String(u).startsWith('blob:'))return u;return u+(u.indexOf('?')<0?'?':'&')+'v='+Math.floor(Math.random()*1e9);}"),
    # ссылки из памяти (blob:) — без «?t=» (с ним blob-адрес не находится и звук не играет)
    ("r.url+'?t='+Date.now()", "(String(r.url).startsWith('blob:')?r.url:r.url+'?t='+Date.now())"),
    ("reel_fullscreen:['🖥 Открыть в плеере на ПК','🖥 Open in PC player']", "reel_fullscreen:['🔍 Смотреть крупно','🔍 Watch large']"),
    # «Галерея» -> в браузере скачивание готового ролика
    ("open_gallery:['📁 Галерея','📁 Gallery']", "open_gallery:['⬇ Скачать ролик','⬇ Download reel']"),
    ("title_open_gallery:['Открыть папку с готовыми рилсами','Open the folder with finished reels']", "title_open_gallery:['Скачать готовый ролик (MP4) на устройство','Download the finished reel (MP4)']"),
    # видео справа: якорь может быть не в правой колонке
    ("if(anchor)R.insertBefore(box,anchor); else R.appendChild(box);", "if(anchor&&anchor.parentNode===R)R.insertBefore(box,anchor); else R.appendChild(box);"),
    # веб обновляется сам — кнопка проверки обновлений не нужна
    ('<button class="rulesbtn" onclick="manualUpdateCheck()"', '<button class="rulesbtn" style="display:none" onclick="manualUpdateCheck()"'),
    # «Галерея» (папка output) в браузере = скачать ролик
    ("open_folder:['📁 Папка output','📁 output folder']", "open_folder:['⬇ Скачать ролик','⬇ Download reel']"),
]
for a, b in UI_PATCHES:
    if s.count(a) < 1: print('PATCH MISS:', a[:90]); continue
    s = s.replace(a, b)
i = s.rindex("</body>")
MOBILE_CSS = """<style id="vrWebMobile">
/* телефон: одна колонка, крупные зоны нажатия, без горизонтальной прокрутки */
/* узкий экран: в приложении правая колонка (превью/готовый ролик) скрыта — в вебе показываем её под остальными */
@media (max-width: 1100px){
  .reelColRight{display:block!important;position:static!important;grid-column:1/-1}
  .reelColRight .sub-frame.reel{max-width:360px!important}
}
@media (max-width: 760px){
  html,body{overflow-x:hidden}
  .reelColLeft,.cmColLeft,.amColLeft{position:static!important}   /* липкая колонка в одну колонку налезала на остальное */
  .btn,button{min-height:42px}
  input,textarea,select{font-size:16px!important}          /* iOS не зумит поле при фокусе */
  #reelColRight,#reelColLeft,#reelColMid{width:100%!important;max-width:100%!important;flex:1 1 100%!important}
  .modal .box,.modalbox,.mbox{max-width:calc(100vw - 24px)!important}
  video{max-width:100%}
  .slider-wrap > span[style*="min-width:120px"]{min-width:0!important}   /* подпись слайдера не выталкивает значение за экран */
  #btnLangReel{white-space:normal!important}
}
</style>
"""
s = s[:i] + MOBILE_CSS + SHIM + s[i:]
s = s.replace("<title>", "<title>Веб · ", 1)
s = s.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', 1)
io.open(OUT, "w", encoding="utf-8").write(s)

# --- copy_assets: те же файлы, что вшиты в сборку (ВидеорилсМини.spec datas) ---
import shutil, json
APP = os.path.dirname(SRC)
WEB = os.path.dirname(OUT)
for rel in ["assets/blogger.png", "assets/preview_big.png", "assets/cam_frame.png", "assets/cam_rec.png", "assets/ultraface.onnx",
            "assets/videos/pexels_api_key_guide.mp4", "assets/videos/pixabay_api_key_guide.mp4",
            "assets/videos/elevenlabs_api_key_guide.mp4", "assets/videos/gemini_api_key_guide.mp4"]:
    d = os.path.join(WEB, rel); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy2(os.path.join(APP, rel), d)
pl_src = os.path.join(APP, "assets", "platform"); pl_dst = os.path.join(WEB, "assets", "platform")
shutil.rmtree(pl_dst, ignore_errors=True); shutil.copytree(pl_src, pl_dst)
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
print("web/lite/index.html", len(s))
