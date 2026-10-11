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
    # серия: «📦 Скачать серию» под каруселью + «Скачать ролик N из M» скачивает показанный ролик
    ("""  box.appendChild(dots);
  phoneBatchActive=true;""", """  box.appendChild(dots);
  if(reels.length>1){ const ds=document.createElement('button'); ds.className='btn ghost'; ds.id='bpSeries'; ds.style.cssText='width:100%;margin-top:8px';
    ds.textContent='📦 Скачать серию ('+reels.length+')'; ds.onclick=()=>{ if(ready())api('download_series').then(r=>{ if(r&&r.ok)toast('Скачиваю '+r.n+' ролика — если браузер спросит, разрешите скачивание нескольких файлов'); }); }; box.appendChild(ds); }
  phoneBatchActive=true;"""),
    ("""  const cnt=$('bpCount'); if(cnt)cnt.textContent=(i+1)+' / '+phoneBatchReels.length;""",
     """  const cnt=$('bpCount'); if(cnt)cnt.textContent=(i+1)+' / '+phoneBatchReels.length;
  const gl=$('reelColGallery'); if(gl)gl.textContent='⬇ Скачать ролик '+(i+1)+' из '+phoneBatchReels.length;"""),
    ("""  const box=$('batchPhone'); if(box){ const vv=$('bpVideo'); if(vv){try{vv.pause();}catch(e){} vv.src='';} box.remove(); }""",
     """  const box=$('batchPhone'); if(box){ const vv=$('bpVideo'); if(vv){try{vv.pause();}catch(e){} vv.src='';} box.remove(); }
  { const gl=$('reelColGallery'); if(gl)gl.textContent=t('open_gallery'); }"""),
    # телефон -> вид «как на ПК» (3 колонки)
    ('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1" id="vrVp"><script>/* телефон -> вид «как на ПК» (3 колонки, как в приложении); планшеты/ПК не трогаем */(function(){try{var c=matchMedia("(pointer:coarse)").matches,w=Math.min(screen.width,screen.height);if(c&&w<900){document.getElementById("vrVp").setAttribute("content","width=1280");document.documentElement.classList.add("vrPhone");}}catch(e){}})();</script>'),
    # веб: слева без «Посмотреть рилс» (ролик и так играет справа)
    ("""        <button class="btn gc" onclick="watchReelBig()" data-i18n="open_reel">▶️ Посмотреть рилс</button>
""", ""),
    # веб: в 3-й колонке вместо «Смотреть крупно» — «Извлечь звук» (если отдельной кнопки нет)
    ("""      fs.textContent=t('reel_fullscreen'); fs.onclick=()=>{ const vv=$(vidId); const u=(vv&&vv.src)||r.url; if(u)showClipModal('video',u,false); };
      box.appendChild(fs);""",
     """      fs.className='btn ghost'; fs.textContent=t('extract_audio'); fs.onclick=()=>extractAudio(fs);
      if(colId==='reelColRight'&&!$('reelColExtract'))box.appendChild(fs);"""),
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
    # веб: без «Сохранить в галерею» — остаётся одна «Скачать ролик», и она качает на ВЫБРАННОЙ скорости
    ("""      if(colId==='reelColRight'){
        const sv=document.createElement('button'); sv.className='btn pp'; sv.id='reelSaveSpeedBtn';""",
     """      if(false){
        const sv=document.createElement('button'); sv.className='btn pp'; sv.id='reelSaveSpeedBtn';"""),
    ("""    gal.onclick=()=>{ if(ready())api('open_folder'); };""",
     """    gal.onclick=()=>{ if(!ready())return;
      const spd=(typeof _reelSpeed!=='undefined')?_reelSpeed:1, batch=(typeof phoneBatchActive!=='undefined')&&phoneBatchActive;
      if(batch||Math.abs(spd-1)<0.001){ api('open_folder'); return; }
      const old=gal.textContent; gal.disabled=true; gal.textContent=t('reel_saving');
      api('save_reel_speed',spd).then(r=>{ gal.disabled=false; gal.textContent=old;
        if(r&&r.ok)api('open_folder'); else toast((r&&r.msg)||t('toast_error'),'err'); })
        .catch(()=>{ gal.disabled=false; gal.textContent=old; toast(t('toast_error'),'err'); }); };"""),
    # веб-подписка: тип ключа «Неделя» (7 дней)
    ("licst_monthly:['Месяц','Monthly'],", "licst_monthly:['Месяц','Monthly'],\n  licst_weekly:['Неделя','Weekly'],"),
    ("lt==='monthly'?t('licst_monthly')", "lt==='weekly'?t('licst_weekly'):lt==='monthly'?t('licst_monthly')"),
    ("(kt==='monthly')?t('licst_monthly')", "(kt==='weekly')?t('licst_weekly'):(kt==='monthly')?t('licst_monthly')"),
    # веб: модель распознавания в браузере меньше, чем в программе (телефон ~77 МБ, ПК ~250–320 МБ)
    ("tr_load_sub:['Первый раз — качается ~460 МБ, потом мгновенно','First run downloads ~460 MB, then it is instant']",
     "tr_load_sub:['Первый раз модель качается (~80 МБ на телефоне, ~300 МБ на ПК), потом мгновенно','First run downloads the model (~80 MB on phone, ~300 MB on PC), then it is instant']"),
    # веб: смена режима «Из видео» НЕ выкидывает загруженное видео и распознанный текст
    # (зона загрузки стоит выше выбора режима — люди грузят файл, потом выбирают режим);
    # сцены/ролик/зона сбрасываются, а уже распознанный текст сразу идёт в новый режим.
    ("""    if(typeof clearForeignDropzone==='function')clearForeignDropzone();
    if(typeof _hideForeignProgress==='function')_hideForeignProgress();
    const ch=$('reelCenterHint'); if(ch)ch.style.display='';
    if(ready())api('clear_foreign_source');   // бэкенд: чужое видео/текст/зона/сцены
  }""",
     """    if(typeof _hideForeignProgress==='function')_hideForeignProgress();
    const ch=$('reelCenterHint'); if(ch)ch.style.display='';
    if(ready())api('reset_foreign_work').then(r=>{ if(r&&r.has_video&&r.segments>0&&typeof window.transcribeDone==='function') setTimeout(()=>window.transcribeDone(r.segments,'foreign',null),0); });
  }"""),
    # веб: «✕ Убрать» — убрать видео и на сервере-части (раньше чистилась только картинка зоны)
    ("""onclick="event.stopPropagation();clearForeignDropzone()">""",
     """onclick="event.stopPropagation();clearForeignDropzone();window.resetForeignWork&&resetForeignWork();ready()&&api(&quot;clear_foreign_source&quot;)">"""),
    # веб: крестик «закрыть» на готовом ролике (3-я колонка) -> снова образец субтитра
    ("wrap.appendChild(v); box.appendChild(wrap);",
     "wrap.appendChild(v); box.appendChild(wrap); { wrap.style.position='relative'; const xb=document.createElement('button'); xb.className='vrResultClose'; xb.title='Закрыть ролик'; xb.textContent='✕'; xb.onclick=(e)=>{ e.stopPropagation(); clearReelResult(); }; wrap.appendChild(xb); } window.vrReelCredits&&vrReelCredits(box);"),
    # веб: «Очистить» убирает и загруженное видео «Из видео» с распознанным текстом
    ("function clearReel(){   // красная «Очистить»: полный сброс к чистому старту (БЕЗ подтверждения)",
     "function clearReel(){   // красная «Очистить»: полный сброс к чистому старту (БЕЗ подтверждения)\n  try{ if(typeof clearForeignDropzone==='function')clearForeignDropzone(); if(ready())api('clear_foreign_source'); }catch(e){}"),
    # «Галерея» (папка output) в браузере = скачать ролик
    ("open_folder:['📁 Папка output','📁 output folder']", "open_folder:['⬇ Скачать ролик','⬇ Download reel']"),
]
for a, b in UI_PATCHES:
    if s.count(a) < 1: print('PATCH MISS:', a[:90]); continue
    s = s.replace(a, b)
# веб: клипы Pexels/Pixabay идут через наш общий ключ — в подсказках не просим вставлять ключи стоков
STOCK_TEXT = [
    ("проверь, что вставлен Pixabay Key (блок ключей сверху)", "обнови страницу и попробуй ещё раз (клип сцены можно заменить своим файлом)"),
    ("добавь несколько ключей Pixabay и ElevenLabs (до 5 каждого)", "добавь несколько ключей ElevenLabs (до 5)"),
    ("Pixabay Key и ElevenLabs Key — до 5 ключей каждый", "ElevenLabs Key — до 5 ключей"),
    ("впиши СВОИ ключи (Pixabay Key, Gemini Key,", "впиши СВОИ ключи (Gemini Key,"),
    ("Для сборки нужен твой Pixabay Key (клипы/видео). Вставь его в разделе «🔑 API-ключи».", "Не удалось подобрать клипы — проверь интернет и попробуй ещё раз."),
    ("клипы — на твоём бесплатном ключе Pixabay, ", "клипы подбираются автоматически, "),
]
for a, b in STOCK_TEXT: s = s.replace(a, b)
i = s.rindex("</body>")
MOBILE_CSS = """<style id="vrWebMobile">
/* телефон: суфлёр крупно — фразу читают вслух с телефона */
html.vrPhone #karaokeOv{align-items:center!important}
html.vrPhone #karaokeOv .modal{max-width:none!important;width:94vw!important}
html.vrPhone #karaokeOv .modal-head .mt{font-size:30px!important}
html.vrPhone #karaokeOv .modal-x{font-size:36px!important;padding:6px 14px!important}
html.vrPhone #karaokeOv #karStage{min-height:42vh!important;gap:28px!important}
html.vrPhone #karaokeOv .kar-cur{font-size:64px!important;line-height:1.25!important}
html.vrPhone #karaokeOv .kar-next{font-size:30px!important}
html.vrPhone #karaokeOv #karPos,html.vrPhone #karaokeOv #karTimer,html.vrPhone #karaokeOv #karSpeedVal{font-size:26px!important}
html.vrPhone #karaokeOv .btn{font-size:30px!important;padding:20px 40px!important}
html.vrPhone #karaokeOv .hint,html.vrPhone #karaokeOv [data-i18n=kar_speed]{font-size:22px!important}
html.vrPhone #karaokeOv input[type=range]{height:40px}
html.vrPhone .kar-count{font-size:220px!important}
.vrResultClose{position:absolute;top:8px;right:8px;z-index:5;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(10,8,20,.72);color:#fff;font-size:17px;font-weight:900;cursor:pointer;line-height:1}
.vrResultClose:hover{background:rgba(220,38,38,.85)}
html.vrPhone .vrResultClose{width:60px;height:60px;font-size:30px;top:12px;right:12px}
/* телефон: одна колонка, крупные зоны нажатия, без горизонтальной прокрутки */
/* узкий экран: в приложении правая колонка (превью/готовый ролик) скрыта — в вебе показываем её под остальными */
@media (max-width: 1100px){
  .reelColRight{display:block!important;position:static!important;grid-column:1/-1}
  .reelColRight .sub-frame.reel{max-width:360px!important}
  /* левая колонка НЕ прилипает и не режется по высоте экрана: иначе при прокрутке она стояла
     на месте и закрывала превью/готовое видео (телефон в «Версии для ПК», планшет) */
  #reelColLeft,#cmColLeft,#amColLeft,.reelColLeft,.cmColLeft,.amColLeft{position:static!important;max-height:none!important;top:auto!important}
  .reelLeftScroll,.cmLeftScroll,.amLeftScroll{max-height:none!important;overflow:visible!important}
  #reelColRight,#cmColRight,#amColRight{position:static!important;max-height:none!important;overflow:visible!important}
  /* экран «С чего начнём?»: карточка нормальных пропорций, а не во весь (высокий) экран; кнопка крупная */
  .home2col{min-height:0!important}
  .homeright .pcard{min-height:0!important;height:auto!important;aspect-ratio:4/5;max-height:640px}
  .pcard .gobtn{padding:16px 34px!important;font-size:18px!important;border-radius:14px!important;min-width:min(78%,320px)}
}
/* 2 колонки (761–1100): превью/готовое видео — ПОД СЦЕНАМИ (2-я колонка), левая — на всю высоту */
@media (min-width: 761px) and (max-width: 1100px){
  .reelColLeft,.cmColLeft,.amColLeft{grid-row:1 / span 2}
  .reelColRight,#cmColRight,#amColRight{grid-column:2!important;grid-row:2}
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
/* телефон: без «стеклянных» эффектов — иначе при быстрой прокрутке белые вспышки (не успевает рисовать) */
html.vrPhone *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
/* телефон в «виде ПК» очень высокий: карточки «С чего начнём?» — нормальных пропорций, кнопка крупная */
html.vrPhone .home2col{min-height:0!important}
/* телефон: окно «Выбери клип для сцены» и просмотр клипа — крупно, по центру, превью по 2 в ряд */
html.vrPhone #swapPicker,html.vrPhone #clipModal{align-items:center!important}
html.vrPhone #swapPicker .modal{max-width:none!important;width:94vw!important}
html.vrPhone #swapPicker .modal-head .mt{font-size:30px!important}
html.vrPhone #swapPicker .modal-x{font-size:34px!important;padding:6px 14px!important}
html.vrPhone #swapPicker .hint{font-size:22px!important}
html.vrPhone #swapPickGrid{grid-template-columns:repeat(2,1fr)!important;gap:16px!important}
html.vrPhone #swapPickGrid .cmcard{border-radius:16px!important}
html.vrPhone #swapPickGrid .cmcard img{height:auto!important;aspect-ratio:3/4;max-height:58vh}
html.vrPhone #swapPicker .btn{font-size:24px!important;min-height:72px!important}
html.vrPhone #clipModalBody video,html.vrPhone #clipModalBody img{max-height:80vh!important;width:auto!important;max-width:92vw!important}
html.vrPhone .homeright .pcard{min-height:0!important;height:auto!important;aspect-ratio:4/5;max-height:760px}
html.vrPhone .pcard .gobtn{padding:18px 40px!important;font-size:20px!important;border-radius:14px!important;min-width:min(70%,340px)}
</style>
<script>/* касания -> мышь для перетаскивания (субтитр, заголовок, логотип, уголки размера): там только mousedown */
(function(){ if(!('ontouchstart' in window))return; var act=null;
  function fire(type,t,target){ var ev=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:t.clientX,clientY:t.clientY,screenX:t.screenX,screenY:t.screenY,button:0,buttons:type==='mouseup'?0:1}); (target||document).dispatchEvent(ev); }
  document.addEventListener('touchstart',function(e){ var el=e.target.closest&&e.target.closest('[onmousedown]'); if(!el||e.touches.length!==1)return; act=el; e.preventDefault(); fire('mousedown',e.touches[0],el); },{passive:false,capture:true});
  document.addEventListener('touchmove',function(e){ if(!act)return; e.preventDefault(); fire('mousemove',e.touches[0],document); },{passive:false,capture:true});
  function end(e){ if(!act)return; fire('mouseup',e.changedTouches[0],document); act=null; }
  document.addEventListener('touchend',end,{capture:true}); document.addEventListener('touchcancel',end,{capture:true});
})();</script>
"""
# веб-подписка: 3 ступени 7 дней / 30 дней / год вместо «Навсегда» + авто-проверка оплаты
WEBSUBS = ('<script>window.__vrWebPlansFB={web_week:{type:"weekly",rub:599,days:7},web_month:{type:"monthly",rub:1799,days:30},web_year:{type:"yearly",rub:13190,days:365}};</script>\n'
           + io.open(os.path.join(os.path.dirname(OUT), "..", "websubs.html"), encoding="utf-8").read())
CREDITS = io.open(os.path.join(os.path.dirname(OUT), "..", "stockcredits.html"), encoding="utf-8").read()
s = s[:i] + MOBILE_CSS + WEBSUBS + CREDITS + SHIM + s[i:]
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
