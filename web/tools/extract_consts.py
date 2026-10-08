# -*- coding: utf-8 -*-
"""Достаёт ДАННЫЕ (константы) из app.py десктопного Мини в web/vr/consts.js —
чтобы промпты/сообщения/стили/словари в веб-версии были БАЙТ-В-БАЙТ как в
приложении. Запуск: python extract_consts.py [путь_к_app.py]
Берём только присваивания верхнего уровня (и уровня класса Api), чьё значение
вычисляется без побочных эффектов (литералы, .replace(), dict-comprehension и т.п.).
"""
import ast, json, re, sys, os

SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\video_factory_МИНИ\app.py"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vr", "consts.js")

src = open(SRC, encoding="utf-8").read()
tree = ast.parse(src)

SKIP = {"BASE", "RES_BASE", "IS_STORE", "DATA_BASE", "INPUT_DIR", "TEMP_DIR", "OUTPUT_DIR",
        "ASSETS_DIR", "MUSIC_DIR", "SFX_DIR", "SETTINGS_FILE", "_OLD_SETTINGS", "BUNDLED_SFX",
        "VOICE_DEMO_DIR", "FFMPEG", "FFPROBE", "window", "CREATE_NO_WINDOW", "ARIBLK",
        "_mu_readme", "_sfx_readme", "_FF_SEM", "_PIX_LOCK", "_EDGE_LOCK", "_AI_LOCK"}

ns = {"re": re, "os": os, "json": json}
out = {}
skipped = []


def conv(v):
    if isinstance(v, re.Pattern):
        fl = ""
        if v.flags & re.I:
            fl += "i"
        return {"__re__": v.pattern, "flags": fl}
    if isinstance(v, (set, frozenset)):
        return {"__set__": sorted((conv(x) for x in v), key=lambda x: json.dumps(x, ensure_ascii=False))}
    if isinstance(v, (list, tuple)):
        return [conv(x) for x in v]
    if isinstance(v, dict):
        return {str(k): conv(x) for k, x in v.items()}
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    raise TypeError(type(v).__name__)


def take(body, prefix=""):
    for node in body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if not names or any(n in SKIP for n in names):
                continue
            code = ast.get_source_segment(src, node)
            try:
                exec(code, ns)
                for n in names:
                    out[prefix + n] = conv(ns[n])
            except Exception as e:
                skipped.append((prefix + names[0], type(e).__name__, str(e)[:60]))


take(tree.body)
for node in tree.body:
    if isinstance(node, ast.ClassDef) and node.name == "Api":
        take(node.body, "Api.")

js = ("// АВТОГЕНЕРАЦИЯ из app.py (tools/extract_consts.py) — НЕ править руками.\n"
      "// Источник: " + os.path.basename(SRC) + "\n"
      "export const RAW = " + json.dumps(out, ensure_ascii=False, indent=1) + ";\n"
      "export default RAW;\n")
open(OUT, "w", encoding="utf-8").write(js)
print("consts:", len(out), "->", os.path.abspath(OUT), os.path.getsize(OUT))
for s in skipped:
    print("  skip", s)
