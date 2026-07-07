# -*- coding: utf-8 -*-
"""Полный SEO-аудит videorils.com. Прогоняет все html репо + live-проверку.
Отчёт -> D:\\videorils_seo\\audit_report.txt. Запуск: python seo_audit.py"""
import re, os, json, glob, sys, io, collections, math, urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = "https://videorils.com"
REPORT = r"D:\videorils_seo\audit_report.txt"
crit, cosm, info = [], [], []
def C(m): crit.append(m)
def K(m): cosm.append(m)

def rel_url(path):
    r = os.path.relpath(path, ROOT).replace("\\", "/")
    return "/" + (r[:-len("index.html")] if r.endswith("index.html") else r)

PAGES = [p for p in glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True)]
# верификационные заглушки (google*.html / yandex_*.html) — не страницы, не аудируем
PAGES = [p for p in PAGES if not re.match(r'^(google|yandex[_-])', os.path.basename(p).lower())]
def readf(p): return open(p, encoding="utf-8", errors="replace").read()

def visible_text(h):
    h = re.sub(r'<head.*?</head>', ' ', h, flags=re.S)
    h = re.sub(r'<script.*?</script>', ' ', h, flags=re.S)
    h = re.sub(r'<style.*?</style>', ' ', h, flags=re.S)
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h)).strip()

# ---- собираем данные по страницам ----
data = {}
titles, descs = collections.Counter(), collections.Counter()
for p in PAGES:
    h = readf(p); url = rel_url(p)
    t = re.search(r'<title>(.*?)</title>', h, re.S)
    d = re.search(r'<meta name="description" content="(.*?)"', h, re.S)
    can = re.search(r'<link rel="canonical" href="(.*?)"', h)
    ogt = re.search(r'<meta property="og:title" content="(.*?)"', h, re.S)
    title = (t.group(1).strip() if t else "")
    desc = (d.group(1).strip() if d else "")
    txt = visible_text(h)
    data[url] = dict(path=p, html=h, title=title, desc=desc,
                     canonical=can.group(1) if can else "",
                     ogt=ogt.group(1).strip() if ogt else "",
                     h1=len(re.findall(r'<h1[ >]', h)),
                     h2s=re.findall(r'<h2[^>]*>(.*?)</h2>', h, re.S),
                     text=txt, tlen=len(txt),
                     metrika=bool(re.search(r'ym\((\d+),', h)),
                     lang=bool(re.search(r'<html[^>]*\blang="[a-z]', h)),
                     charset=('charset=utf-8' in re.sub(r'["\' ]', '', h.lower())),
                     viewport='name="viewport"' in h,
                     ld=re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S),
                     links=re.findall(r'href="(/[^"#]*)"', h))
    if title: titles[title]+=1
    if desc: descs[desc]+=1

# ---- 7. title/desc/H1 ----
for url, d in data.items():
    if not d["title"]: C(f"{url}: НЕТ <title>")
    elif len(d["title"])>65: K(f"{url}: title {len(d['title'])}>65 зн.: {d['title'][:50]}")
    if d["title"] and titles[d["title"]]>1: C(f"{url}: title НЕ уникален ({titles[d['title']]}×): {d['title'][:45]}")
    if not d["desc"]: C(f"{url}: НЕТ description")
    elif len(d["desc"])>165: K(f"{url}: description {len(d['desc'])}>165 зн.")
    if d["desc"] and descs[d["desc"]]>1: C(f"{url}: description НЕ уникален ({descs[d['desc']]}×)")
    if d["h1"]!=1: C(f"{url}: H1={d['h1']} (нужен ровно 1)")
    # 8 canonical
    if not d["canonical"]: C(f"{url}: НЕТ canonical")
    elif not d["canonical"].startswith("https://videorils.com"): C(f"{url}: canonical не абсолютный: {d['canonical']}")
    elif d["canonical"].rstrip("/")!=(SITE+url).rstrip("/"): K(f"{url}: canonical != URL ({d['canonical']})")
    # 9 OG
    if not d["ogt"]: K(f"{url}: НЕТ og:title")
    elif d["title"] and d["ogt"]!=d["title"]: K(f"{url}: og:title != title")
    for og in ("og:description","og:image","og:url"):
        if f'property="{og}"' not in d["html"]: K(f"{url}: НЕТ {og}")
    # 11 metrika
    if not d["metrika"]: C(f"{url}: НЕТ Яндекс.Метрики")
    # 13 tech
    if not d["lang"]: K(f"{url}: нет атрибута lang у <html>")
    if not d["charset"]: K(f"{url}: нет charset utf-8")
    if not d["viewport"]: K(f"{url}: нет viewport")

# метрика: один ли счётчик
ids = set(re.findall(r'ym\((\d+),', "".join(d["html"] for d in data.values())))
info.append(f"Счётчиков Метрики (уник. номеров): {sorted(ids)}")

# ---- 10 schema JSON-LD валидность + типы ----
home = data.get("/")
if home:
    types = []
    for b in home["ld"]:
        try: types.append(json.loads(b).get("@type"))
        except Exception as e: C(f"/: битый JSON-LD: {e}")
    if "SoftwareApplication" not in types: C("/: НЕТ SoftwareApplication schema")
for url, d in data.items():
    if url.startswith("/guides/") and url!="/guides/":
        has_faq=False
        for b in d["ld"]:
            try:
                if json.loads(b).get("@type")=="FAQPage": has_faq=True
            except Exception as e: C(f"{url}: битый JSON-LD: {e}")
        if not has_faq: K(f"{url}: нет FAQPage schema")

# ---- 12 внутренние ссылки -> существуют ----
def resolve(link):
    link=link.split("?")[0]
    if link.endswith("/"): cand=os.path.join(ROOT, link.strip("/"), "index.html")
    elif link=="/" : cand=os.path.join(ROOT,"index.html")
    elif "." in os.path.basename(link): cand=os.path.join(ROOT, link.strip("/"))
    else: cand=os.path.join(ROOT, link.strip("/"), "index.html")
    return cand
broken=set()
for url,d in data.items():
    for l in d["links"]:
        if l.startswith("//"): continue
        cand=resolve(l)
        if not os.path.exists(cand) and not os.path.exists(os.path.join(ROOT,l.strip("/"))):
            broken.add((url,l))
for url,l in sorted(broken): C(f"{url}: битая внутр. ссылка -> {l}")

# сироты: достижимость с главной BFS <=3
graph={u:set() for u in data}
for u,d in data.items():
    for l in d["links"]:
        lu=l if l.endswith("/") or "." in os.path.basename(l) else l+"/"
        if lu in data: graph[u].add(lu)
seen={"/"}; frontier={"/"}; depth=0
while frontier and depth<3:
    nxt=set()
    for u in frontier: nxt|=graph.get(u,set())
    nxt-=seen; seen|=nxt; frontier=nxt; depth+=1
orphans=[u for u in data if u not in seen and u!="/"]
if orphans: C(f"СИРОТЫ (недостижимы с главной ≤3 клика): {len(orphans)} -> {orphans[:6]}")

# ---- 1 дубли FAQ на странице (fuzzy) ----
def norm(q): return re.sub(r'[^а-яё0-9 ]',' ',q.lower())
def sim(a,b):
    A,B=set(norm(a).split()),set(norm(b).split())
    if not A or not B: return 0
    return len(A&B)/len(A|B)
for url,d in data.items():
    qs=re.findall(r'<summary>(.*?)</summary>', d["html"], re.S)
    qs=[re.sub(r'<[^>]+>','',q).strip() for q in qs]
    for i in range(len(qs)):
        for j in range(i+1,len(qs)):
            if sim(qs[i],qs[j])>=0.8: C(f"{url}: дубль FAQ (~{int(sim(qs[i],qs[j])*100)}%): «{qs[i][:40]}» ≈ «{qs[j][:40]}»")

# ---- 2 падежи городов в анкорах ----
try:
    sys.path.insert(0, os.path.join(os.path.dirname(ROOT),"..")) # на случай
except Exception: pass
# берём PREP из seo_gen если рядом
PREP={}
for cand in [os.path.join(r"C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin\b43cdef7-e345-40d5-9811-2d0508e42f6f\scratchpad","seo_gen.py")]:
    if os.path.exists(cand):
        src=open(cand,encoding="utf-8").read()
        m=re.search(r'PREP = \{(.*?)\n\}', src, re.S)
        if m:
            for a,b in re.findall(r'"([^"]+)":"([^"]+)"', m.group(1)): PREP[a]=b
noms=set(re.findall(r'"[a-z-]+":"[^"]+"', "")) # placeholder
# ищем "Рилсы в X" / "Раскрутка в X" где X — именительный (совпадает с city name, не с prep)
citynames={}
for url in data:
    if url.startswith("/goroda/") and url!="/goroda/":
        slug=url.strip("/").split("/")[-1]
        citynames[slug]=None
# сверяем анкоры: если анкор содержит именительную форму (нет в PREP-значениях) — флаг
prep_vals=set(PREP.values())
for url,d in data.items():
    for anc in re.findall(r'(?:Рилсы|Раскрутка) в ([А-ЯЁ][а-яё\- ]+?)(?:<|,)', d["html"]):
        anc=anc.strip()
        if anc and anc not in prep_vals and anc not in ("вашем городе","городе"):
            K(f"{url}: возможно кривой падеж анкора: «в {anc}»")

# ---- 3 переспам ----
STOP=set("и в во на с со что как для не по это а но или же бы ли то из у о об от за до над под при про без через между чтобы если когда где чем тем так там уже ещё вы ты он она оно они мы вам вас нас его её их им них свой это этот эта эти тот те весь все всё быть есть был была было были будет будут можно нужно надо очень каждый один раз к да нет вот этом этого этой ваш ваша ваше ваши мой сам уже лишь даже потом затем после тоже здесь сейчас потому поэтому".split())
for url,d in data.items():
    ws=re.findall(r'[а-яё]{3,}', d["text"].lower()); tot=len(ws) or 1
    if tot<300: continue                         # мало русского текста (англ. легаси) — density нерелевантна
    if url in ("/guides/","/goroda/"): continue  # хаб-листинги: плотность ключа естественна
    sig=collections.Counter(w for w in ws if w not in STOP)
    if sig:
        w,c=sig.most_common(1)[0]; dens=c/tot*100
        if dens>4.5: K(f"{url}: переспам «{w}» {dens:.1f}% (>4.5%)")
    # ключ в H2
    h2t=[re.sub(r'<[^>]+>','',x).lower() for x in d["h2s"]]

# ---- 4 плейсхолдеры ----
for url,d in data.items():
    for pat in [r'\{город\}', r'\{ключ\}', r'\{\{', r'\[TODO\]', r'\{slug\}', r'\{city\}', r'lorem ipsum']:
        if re.search(pat, d["html"], re.I): C(f"{url}: остаток генерации {pat}")

# ---- 5 мин длина ----
for url,d in data.items():
    if url.startswith("/guides/") and url!="/guides/" and d["tlen"]<3500: K(f"{url}: гайд короткий {d['tlen']}<3500 зн.")
    if url.startswith("/goroda/") and url!="/goroda/" and d["tlen"]<2000: K(f"{url}: город короткий {d['tlen']}<2000 зн.")

# ---- 6 дубликаты между городами (шинглы) ----
def shingles(t):
    ws=re.findall(r'[а-яё]{3,}', t.lower())
    return set(" ".join(ws[i:i+5]) for i in range(len(ws)-4))
cityp={u:shingles(d["text"]) for u,d in data.items() if u.startswith("/goroda/") and u!="/goroda/"}
keys=list(cityp); worst=0
for i in range(len(keys)):
    for j in range(i+1,len(keys)):
        a,b=cityp[keys[i]],cityp[keys[j]]
        if not a or not b: continue
        ov=len(a&b)/min(len(a),len(b))
        if ov>worst: worst=ov
        if ov>0.30: C(f"дубль контента {keys[i]} ~ {keys[j]}: {int(ov*100)}% совпадение шинглов")
info.append(f"Макс. совпадение шинглов между городами: {int(worst*100)}% (норма <30%)")

# ---- 14 sitemap ----
smp=os.path.join(ROOT,"sitemap.xml")
if not os.path.exists(smp): C("НЕТ sitemap.xml")
else:
    s=readf(smp)
    locs=re.findall(r'<loc>(.*?)</loc>', s)
    lm=re.findall(r'<lastmod>(.*?)</lastmod>', s)
    repo_urls=set(SITE+u for u in data)
    smp_urls=set(locs)
    miss=repo_urls-smp_urls; extra=smp_urls-repo_urls
    if miss: C(f"sitemap: НЕ хватает {len(miss)} URL репо: {list(miss)[:5]}")
    if extra: C(f"sitemap: {len(extra)} URL которых нет в репо: {list(extra)[:5]}")
    if not all(u.startswith("https://videorils.com/") for u in locs): C("sitemap: есть не-абсолютные URL")
    if not all(re.match(r'\d{4}-\d{2}-\d{2}', x) for x in lm): K("sitemap: кривой lastmod")
    info.append(f"sitemap: {len(locs)} URL, lastmod у {len(lm)}")

# ---- 15 robots ----
rb=os.path.join(ROOT,"robots.txt")
if not os.path.exists(rb): C("НЕТ robots.txt")
else:
    r=readf(rb)
    if "Sitemap: https://videorils.com/sitemap.xml" not in r: C("robots.txt: нет строки Sitemap")
    if re.search(r'(?im)^\s*Disallow:\s*/\s*$', r): C("robots.txt: Disallow: / (блокирует весь сайт!)")

# ---- 16 файлы подтверждения ----
yv=glob.glob(os.path.join(ROOT,"yandex_*.html"))+([1] if 'yandex-verification' in (home["html"] if home else "") else [])
gv=glob.glob(os.path.join(ROOT,"google*.html"))
info.append(f"Яндекс-подтверждение: {'да (meta/файл)' if yv else 'НЕТ'} · Google-файл: {[os.path.basename(x) for x in gv] or 'НЕТ'}")

# ---- 17/18 live ----
def live(u):
    try:
        req=urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"})
        r=urllib.request.urlopen(req, timeout=25); b=r.read()
        return r.status, len(b)
    except Exception as e:
        return None, str(e)[:40]
import random
random.seed(7)
sample=random.sample(list(data), min(18, len(data)))
live_bad=0
for u in sample:
    st,sz=live(SITE+u)
    if st!=200: live_bad+=1; C(f"LIVE {u}: статус {st} ({sz})")
    elif isinstance(sz,int) and sz<5000: K(f"LIVE {u}: размер {sz}<5KB")
for extra in ["/robots.txt","/sitemap.xml"]:
    st,sz=live(SITE+extra)
    if st!=200: C(f"LIVE {extra}: статус {st}")
info.append(f"LIVE проверено {len(sample)} URL + robots + sitemap; провалов: {live_bad}")

# ---- отчёт ----
out=[]
out.append("="*70)
out.append(f"SEO-АУДИТ videorils.com — страниц: {len(data)}")
out.append("="*70)
out.append("\n## СВОДКА")
for m in info: out.append("  · "+m)
out.append(f"\n## КРИТИЧНЫЕ ({len(crit)})")
out += ["  ✗ "+m for m in crit] or ["  (нет)"]
out.append(f"\n## КОСМЕТИКА ({len(cosm)})")
out += ["  · "+m for m in cosm[:120]] or ["  (нет)"]
if len(cosm)>120: out.append(f"  ...и ещё {len(cosm)-120}")
rep="\n".join(out)
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
open(REPORT,"w",encoding="utf-8").write(rep)
print(rep[:2500])
print(f"\n\nПОЛНЫЙ ОТЧЁТ: {REPORT}  | критичных: {len(crit)}, косметики: {len(cosm)}")
