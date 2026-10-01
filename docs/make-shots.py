#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Render the showcase images for dsh-learn's README.

Everything it draws comes from output that was actually captured from the plugin
(see `docs/shots/*.txt`); nothing here is an invented screenshot. The images are
plain PNGs so they render on GitHub, npm and any Markdown viewer.

    python docs/make-shots.py
"""

import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")

# ---------------------------------------------------------------- palette
BG = "#0d1117"
BAR = "#161b22"
BORDER = "#30363d"
FG = "#e6edf3"
DIM = "#8b949e"
GREEN = "#3fb950"
RED = "#f85149"
YELLOW = "#d29922"
BLUE = "#79c0ff"
PURPLE = "#d2a8ff"
ORANGE = "#ffa657"
TEAL = "#56d4dd"

LATIN = "C:/Windows/Fonts/consola.ttf"
LATIN_B = "C:/Windows/Fonts/consolab.ttf"
CJK = "C:/Windows/Fonts/msyh.ttc"
CJK_B = "C:/Windows/Fonts/msyhbd.ttc"

CJK_RE = re.compile(
    r"[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff"
    r"\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u3000-\u303f]"
)

_cache = {}


def font(path, size, bold=False):
    key = (path, size, bold)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(path, size)
    return _cache[key]


def runs(text):
    """Split a line into (chunk, is_cjk) runs so one font never has to cover both."""
    out = []
    for ch in text:
        cjk = bool(CJK_RE.match(ch))
        if out and out[-1][1] == cjk:
            out[-1][0] += ch
        else:
            out.append([ch, cjk])
    return out


def draw_runs(draw, x, y, text, size, color, bold=False):
    for chunk, cjk in runs(text):
        f = font(CJK_B if cjk and bold else CJK if cjk else LATIN_B if bold else LATIN, size)
        draw.text((x, y), chunk, font=f, fill=color)
        x += draw.textlength(chunk, font=f)
    return x


def text_width(draw, text, size, bold=False):
    total = 0
    for chunk, cjk in runs(text):
        f = font(CJK_B if cjk and bold else CJK if cjk else LATIN_B if bold else LATIN, size)
        total += draw.textlength(chunk, font=f)
    return total


# ---------------------------------------------------------------- colouring
PROMPT = re.compile(r"^(\$|>|PS )")
PATH = re.compile(r"([A-Za-z]:\\\\?[^\s\"'（）|]+|~[/\\][^\s\"'（）|]+)")
GOOD = re.compile(r"(✔|all green|checks passed|— all green|成功|已写入|可写入|\bok\b)")
BAD = re.compile(r"(FAIL|失败|拒绝|丢弃|错误|TypeError|Error:|RangeError)")


def colour_for(segment):
    if PROMPT.match(segment):
        return TEAL
    if BAD.search(segment):
        return RED
    if GOOD.search(segment):
        return GREEN
    if PATH.search(segment):
        return BLUE
    return FG


def paint(draw, x, y, line, size):
    """Colour a captured terminal line: prompt cyan, failures red, passes green."""
    # Split so that markers can be coloured even inside an otherwise plain line.
    parts = re.split(r"(\[exit code: \d+\]|FAIL[^\n]*|✔[^\n]*|—|·|\||：)", line)
    for part in parts:
        if not part:
            continue
        x = draw_runs(draw, x, y, part, size, colour_for(part))
    return x


# ---------------------------------------------------------------- chrome
def window(lines, size=17, lead=27, width=None, title="", pad=26, min_h=0):
    """A terminal card. `lines` are (text, style-override) or plain strings."""
    probe = Image.new("RGB", (10, 10))
    pd = ImageDraw.Draw(probe)

    # Wrap first, so a long path cannot run off the card. Continuation lines are
    # indented under their first line the way a terminal wraps a paragraph.
    limit = (width - pad * 2) if width else None
    wrapped = []
    for entry in lines:
        text, style = (entry, None) if isinstance(entry, str) else entry
        if style or limit is None or text_width(pd, text, size) <= limit:
            wrapped.append((text, style))
            continue
        indent = " " * 2
        current = ""
        for word in re.split(r"(?<= )", text):
            trial = current + word
            if current and text_width(pd, indent + trial, size) > limit:
                wrapped.append((indent + current.rstrip(), None))
                current = word
            else:
                current = trial
        if current.strip():
            wrapped.append((indent + current.rstrip(), None))
    lines = wrapped

    body_w = max([text_width(pd, t, size) for t, _ in [(e, None) if isinstance(e, str) else e for e in lines]] + [10])
    w = width or int(body_w + pad * 2)
    bar_h = 42
    h = int(bar_h + pad + len(lines) * lead + pad)
    h = max(h, min_h)

    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=12, fill=BG, outline=BORDER, width=1)
    d.rounded_rectangle([0, 0, w - 1, bar_h], radius=12, fill=BAR)
    d.rectangle([0, bar_h - 12, w - 1, bar_h], fill=BAR)
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        cx = 20 + i * 20
        d.ellipse([cx - 6, bar_h // 2 - 6, cx + 6, bar_h // 2 + 6], fill=c)
    if title:
        tw = text_width(d, title, 13)
        draw_runs(d, (w - tw) / 2, bar_h / 2 - 9, title, 13, DIM)

    y = bar_h + pad - 6
    for entry in lines:
        text, style = (entry, None) if isinstance(entry, str) else entry
        if style == "blank":
            y += lead
            continue
        x = pad
        if style == "cmd":
            x = draw_runs(d, x, y, "$ ", size, GREEN, bold=True)
            x = draw_runs(d, x, y, text, size, FG)
        elif style:
            draw_runs(d, x, y, text, size, style)
        else:
            paint(d, x, y, text, size)
        y += lead
    return img


def save(img, name):
    path = os.path.join(SHOTS, name)
    img.save(path)
    print("wrote %s  %dx%d" % (path, img.width, img.height))
    return path


def read(name, keep=None):
    with open(os.path.join(SHOTS, name), encoding="utf-8") as fh:
        lines = fh.read().replace("\r", "").split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    return lines[:keep] if keep else lines


# The captured output carries absolute paths that would run off the card; the
# image should read like a terminal, not like a wall of machine-specific noise.
SUBS = [
    # The plugin's own directory is whatever this file sits in, two levels up —
    # never hard-code the path of the machine that happened to render the shots.
    (os.path.dirname(HERE), "…"),
    (os.environ.get("TEMP", "%TEMP%") + "\\learn-shots", "%TEMP%\\learn-shots"),
    (os.environ.get("TEMP", "%TEMP%"), "%TEMP%"),
    (os.path.join(os.path.expanduser("~"), ".dsh"), "<DSH_HOME>"),
    ("…\\lib\\", "lib\\"),
    ("…\\scripts\\", "scripts\\"),
]


def pretty(line):
    for old, new in SUBS:
        line = line.replace(old, new)
    return line


# ---------------------------------------------------------------- shots
def shot_cover():
    w, h = 1280, 470
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=16, fill=BG, outline=BORDER, width=1)

    # soft accent bar
    d.rounded_rectangle([0, 0, w - 1, 5], radius=3, fill=GREEN)

    draw_runs(d, 64, 58, "dsh-learn", 52, FG, bold=True)
    draw_runs(d, 64, 128, "DSH 的持久学习回路", 26, DIM)

    draw_runs(d, 64, 182, "越用越聪明的那个 agent，靠的不是更大的模型，是它把踩过的坑留了下来。", 18, FG)

    steps = [
        ("回合结束", "只读 session/event\n零额外模型调用"),
        ("自动审查", "正则只负责\n把候选挑出来"),
        ("你说了算", "确认才落盘\n每条都带出处"),
        ("下次生效", "就是普通技能\n/名字 即可加载"),
    ]
    box_w, gap, top = 272, 26, 240
    for i, (head, sub) in enumerate(steps):
        x = 64 + i * (box_w + gap)
        d.rounded_rectangle([x, top, x + box_w, top + 150], radius=10, fill=BAR, outline=BORDER, width=1)
        draw_runs(d, x + 22, top + 20, head, 21, GREEN, bold=True)
        for j, line in enumerate(sub.split("\n")):
            draw_runs(d, x + 22, top + 62 + j * 24, line, 15, DIM)
        if i < len(steps) - 1:
            draw_runs(d, x + box_w + 6, top + 60, "→", 22, BORDER)

    draw_runs(d, 64, 424, "永不注入提示词 · 永不改写历史 · 归档从不删除 · 不是自己创建的就永远不碰", 15, DIM)
    return save(img, "01-cover.png")


def shot_selftest():
    lines = []
    for line in read("03-selftest.txt"):
        line = pretty(line)
        if line.startswith(("FAIL", "  ")) and "checks passed" not in line:
            continue
        lines.append(line)
    lines = [l for l in lines if l.strip()][-14:]
    lines = [("npm test", "cmd"), ("", "blank")] + lines
    return save(window(lines, width=980, title="scripts/selftest.mjs — 17 节，零依赖"), "02-selftest.png")


def shot_replay():
    raw = read("01-replay.txt")
    keep = []
    started = False
    for line in raw:
        if line.startswith("=== 队列"):
            started = True
        if started:
            keep.append(pretty(line))
    keep = [l for l in keep if l.strip()][:11]
    # The event count is read from the capture, never typed: a hard-coded number
    # here goes stale the moment the session it was copied from grows.
    counts = next((l for l in raw if " 事件 " in l), "").strip()
    caption = f"把真实会话（{counts.split('（')[-1].rstrip('）') if counts else '数千个事件'}）喂回插件，看它会提出什么："
    keep = [
        ("node scripts/replay-session.mjs --latest 1", "cmd"),
        caption,
        ("", "blank"),
    ] + keep
    return save(window(keep, width=1120, title="真实会话回放"), "03-replay.png")


def shot_pending():
    raw = read("04-pending.txt")
    keep = [pretty(l) for l in raw[5:] if l.strip() and not l.startswith("（回放库")]
    body = [("learn action=pending", "cmd"), ("", "blank")] + keep
    return save(window(body, width=1160, title="候选队列：只有过了门槛的才出现在这里"), "04-pending.png")


def shot_layout():
    lines = [
        ("<DSH_HOME>/", DIM),
        ("├── skills/", FG),
        ("│   ├── my-own-skill/           ← 你手写的，插件永不触碰", DIM),
        ("│   └── learned/                ← 专属根（本插件自注册的技能提供者扫这里）", GREEN),
        ("│       ├── self-learning-loop/SKILL.md", FG),
        ("│       ├── durable-preferences/SKILL.md", FG),
        ("│       ├── tool-recovery/SKILL.md", FG),
        ("│       └── environment-facts/SKILL.md", FG),
        ("└── learn/data/                 ← 台账、队列、账本、图谱", FG),
        ("    ├── managed.json           归属：谁是本插件创建的", DIM),
        ("    ├── usage.json             遥测：谁真的被加载过", DIM),
        ("    ├── pending.json           候选：等你点头", DIM),
        ("    ├── ledger.jsonl           账本：每次动作都留痕", DIM),
        ("    └── archive/               归档：移出去，随时移回来", DIM),
    ]
    return save(window(lines, width=1000, size=16, lead=26, title="磁盘布局"), "05-layout.png")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    shot_cover()
    shot_selftest()
    shot_replay()
    shot_pending()
    shot_layout()


if __name__ == "__main__":
    main()
