#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
seo_gen.py — перекраска шапки / футера / кнопок и всей CSS-палитры
SEO-страниц (гайды + города) из старой мятно-зелёной гаммы в палитру
«Неоновый закат» (в тон новой главной videorils.com).

ЧТО ДЕЛАЕТ:
  • заменяет ТОЛЬКО цветовые токены (hex + rgb/rgba-каналы) внутри страниц;
    эти токены встречаются исключительно в <style>/inline-style, поэтому
    текстовый контент, <title>, meta, canonical, og/twitter, schema.org
    и счётчик Яндекс.Метрики не затрагиваются.
  • идемпотентен: повторный запуск ничего не портит (целевые токены не
    совпадают с исходными).

ОБЛАСТЬ: guides/**/index.html и goroda/**/index.html (включая хабы).

Запуск:  python seo_gen.py            # применить
         python seo_gen.py --check    # только показать, что осталось зелёным
"""
import re
import sys
import glob
import os

ROOT = os.path.dirname(os.path.abspath(__file__))

# ── Палитра «Неоновый закат» ────────────────────────────────────────────
#   фон #0D0716 · градиент #FF3D8A→#7B2FFF · деталь #FF8A3D
#   текст #F2EEF8 / #9A8FB0 · стекло rgba(255,255,255,.04)+рамка rgba(255,61,138,.25)

# rgb/rgba — заменяем только «префикс каналов», альфа и скобка сохраняются
CHANNEL_MAP = {
    "rgba(52,232,158": "rgba(255,61,138",   # мятный акцент  → неон-розовый
    "rgb(52,232,158":  "rgb(255,61,138",
    "rgba(124,92,255": "rgba(123,47,255",   # фиолетовый     → неон-фиолет
    "rgb(124,92,255":  "rgb(123,47,255",
    "rgba(16,42,32":   "rgba(30,18,52",     # зелёная панель → тёмно-фиолет панель
    "rgb(16,42,32":    "rgb(30,18,52",
    "rgba(10,23,18":   "rgba(13,7,22",      # шапка (тёмно-зелёный) → фон закат
    "rgb(10,23,18":    "rgb(13,7,22",
    "rgba(9,7,16":     "rgba(13,7,22",      # шапка (ребренд) → фон закат
    "rgb(9,7,16":      "rgb(13,7,22",
    # rgba(255,255,255 — белое стекло, оставляем как есть
}

# hex — точные токены (в файлах — нижний регистр)
HEX_MAP = {
    "#34e89e": "#FF3D8A",   # акцент мята      → розовый
    "#16c485": "#7B2FFF",   # акцент мята-2    → фиолетовый (конец градиента)
    "#5cf5b4": "#FF8A3D",   # светлая мята     → оранж-деталь
    "#22d3ee": "#7B2FFF",   # циан (если есть) → фиолетовый
    "#eafff6": "#F2EEF8",   # яркий текст      → светлый текст
    "#e8f5ee": "#F2EEF8",   # текст            → светлый текст
    "#f4fffa": "#FFFFFF",   # h1-градиент верх → белый
    "#c4ead8": "#C9BFE0",   # h1-градиент низ  → лавандовый
    "#bfe6d4": "#C9BFE0",
    "#cfeede": "#C9BFE0",   # текст ссылок     → лавандовый
    "#b7d4c7": "#9A8FB0",   # приглушённый     → dim
    "#8fb3a4": "#9A8FB0",   # футер dim        → dim
    "#5c7a6d": "#6E6386",   # dimmer           → dimmer
    "#d0e8de": "#E6DDF2",
    "#d3ece0": "#E6DDF2",
    "#0a1712": "#150C26",   # тёмная панель    → тёмно-фиолет панель
    "#070510": "#0D0716",   # база фона        → фон закат
    "#08120c": "#0D0716",   # трек скроллбара  → фон закат
    "#08130d": "#FFFFFF",   # ТЁМНЫЙ текст на градиент-кнопке/лого → белый
    "#04140d": "#FFFFFF",   # то же (вариант)
    "#04140c": "#FFFFFF",   # то же (вариант, галочка шага)
}

GREEN_LEFTOVER = re.compile(r"(52,232,158|#34e89e|#16c485|#5cf5b4|#eafff6|#e8f5ee)", re.I)


def recolor(text: str) -> str:
    for src, dst in CHANNEL_MAP.items():
        text = text.replace(src, dst)
    # hex — с учётом обоих регистров
    for src, dst in HEX_MAP.items():
        text = text.replace(src, dst)
        text = text.replace(src.upper(), dst)
    return text


def targets():
    pats = [
        os.path.join(ROOT, "guides", "**", "index.html"),
        os.path.join(ROOT, "goroda", "**", "index.html"),
    ]
    files = []
    for p in pats:
        files += glob.glob(p, recursive=True)
    return sorted(set(files))


def main():
    check = "--check" in sys.argv
    files = targets()
    if not files:
        print("Файлы не найдены — запусти из корня сайта.")
        return
    changed = 0
    green_left = 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            orig = fh.read()
        if check:
            if GREEN_LEFTOVER.search(orig):
                green_left += 1
                print("  зелёный остался:", os.path.relpath(f, ROOT))
            continue
        new = recolor(orig)
        if new != orig:
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(new)
            changed += 1
    if check:
        print(f"Проверка: {green_left} файлов с зелёным из {len(files)}")
    else:
        print(f"Перекрашено {changed} из {len(files)} страниц (гайды+города).")
        # само-проверка
        left = [f for f in files if GREEN_LEFTOVER.search(open(f, encoding="utf-8").read())]
        print(f"Осталось зелёного: {len(left)} файлов" + (" — OK" if not left else ""))
        for f in left[:10]:
            print("   ", os.path.relpath(f, ROOT))


if __name__ == "__main__":
    main()
