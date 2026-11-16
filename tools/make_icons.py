#!/usr/bin/env python3
"""把一張真實鍋貼照片（PNG / JPG）轉成 PWA 所需的全部圖示，並加上金色發光效果。

用法：
    python3 tools/make_icons.py 原始照片.jpg
    python3 tools/make_icons.py 原始照片.png --center 0.5 0.55 --zoom 1.2 --glow 0.8

參數：
    --center X Y  鍋貼在照片中的中心位置（0~1，預設 0.5 0.5 = 正中央）
    --zoom Z      放大倍率，>1 會裁得更緊（預設 1.0）
    --glow G      發光強度 0~1.5（預設 1.0）

輸出到 icons/：
    icon-192.png, icon-512.png                 一般圖示
    icon-maskable-192.png, icon-maskable-512.png  Android 可裁切圖示（主體縮在安全區內）
    apple-touch-icon.png (180)                  iPhone / iPad 主畫面
    favicon-32.png, favicon-16.png, favicon.ico 瀏覽器分頁
需求：Pillow（pip install pillow）
"""
import argparse
import os

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
GOLD = (255, 190, 100)
COFFEE = (40, 26, 19)


def square_crop(img, cx, cy, zoom):
    w, h = img.size
    side = min(w, h) / max(zoom, 0.1)
    side = min(side, w, h)
    left = min(max(cx * w - side / 2, 0), w - side)
    top = min(max(cy * h - side / 2, 0), h - side)
    return img.crop((round(left), round(top), round(left + side), round(top + side)))


def radial(size, inner, outer, power=1.6):
    """中心 inner 色 → 外圈 outer 色的放射漸層。"""
    n = 256
    grad = Image.new("L", (n, n))
    px = grad.load()
    c = (n - 1) / 2
    for y in range(n):
        for x in range(n):
            d = min(1.0, (((x - c) ** 2 + (y - c) ** 2) ** 0.5) / c)
            px[x, y] = int(255 * (d ** power))
    grad = grad.resize((size, size), Image.BICUBIC)
    return Image.composite(Image.new("RGB", (size, size), outer), Image.new("RGB", (size, size), inner), grad)


def soft_disc(size, diameter, blur, value=255):
    m = Image.new("L", (size, size), 0)
    o = (size - diameter) / 2
    ImageDraw.Draw(m).ellipse((o, o, o + diameter, o + diameter), fill=value)
    return m.filter(ImageFilter.GaussianBlur(blur)) if blur else m


def rays(size, count=16, strength=1.0):
    """從中心放射的柔和光芒。"""
    import math
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    c = size / 2
    for i in range(count):
        a = 2 * math.pi * i / count
        w = math.pi / count * 0.45
        r = size * 0.75
        d.polygon([(c, c),
                   (c + r * math.cos(a - w), c + r * math.sin(a - w)),
                   (c + r * math.cos(a + w), c + r * math.sin(a + w))], fill=int(70 * strength))
    m = m.filter(ImageFilter.GaussianBlur(size * 0.02))
    fade = ImageChops.invert(radial(size, (255, 255, 255), (0, 0, 0), power=0.9).convert("L"))
    return ImageChops.multiply(m, ImageChops.invert(fade))


def compose(photo, size, frac, glow):
    """深咖啡底 + 金色放射光 + 光暈 + 圓形鍋貼照片 + 金邊。"""
    bg = radial(size, (92, 56, 30), COFFEE, power=1.1)
    gold = Image.new("RGB", (size, size), GOLD)

    # 放射光芒
    bg = Image.composite(gold, bg, rays(size, 18, glow))
    # 主體後方的大光暈（多層，越外越淡）
    diam = int(size * frac)
    for scale, blur, val in ((1.08, 0.07, 255), (1.28, 0.13, 150), (1.55, 0.2, 80)):
        halo = soft_disc(size, int(diam * scale), size * blur, int(val * min(glow, 1.2) / 1.2))
        bg = Image.composite(gold, bg, halo)

    # 圓形鍋貼照片（亮部微泛光）
    ph = photo.resize((diam, diam), Image.LANCZOS)
    ph = ImageEnhance.Color(ImageEnhance.Contrast(ph).enhance(1.05)).enhance(1.12)
    lum = ph.convert("L").point(lambda v: max(0, v - 170) * 3)
    bloom = Image.composite(Image.new("RGB", ph.size, GOLD), Image.new("RGB", ph.size, (0, 0, 0)), lum)
    ph = ImageChops.screen(ph, ImageEnhance.Brightness(bloom.filter(ImageFilter.GaussianBlur(diam * 0.03))).enhance(0.5 * glow))
    # 照片邊緣往內帶一點金色內光
    inner = ImageChops.invert(soft_disc(diam, int(diam * 0.86), diam * 0.06))
    ph = ImageChops.screen(ph, Image.composite(Image.new("RGB", ph.size, (150, 100, 40)), Image.new("RGB", ph.size, (0, 0, 0)), inner))
    off = (size - diam) // 2
    bg.paste(ph, (off, off), soft_disc(diam, diam, max(1, diam * 0.004)))

    # 亮金色外框
    ring = Image.new("L", (size, size), 0)
    w = max(2, int(size * 0.018))
    o = off - w // 2
    ImageDraw.Draw(ring).ellipse((o, o, o + diam + w, o + diam + w), outline=255, width=w)
    bg = Image.composite(Image.new("RGB", (size, size), (255, 214, 140)), bg, ring.filter(ImageFilter.GaussianBlur(w * 0.35)))
    glow_ring = ring.filter(ImageFilter.GaussianBlur(size * 0.025))
    bg = ImageChops.screen(bg, Image.composite(gold, Image.new("RGB", (size, size), (0, 0, 0)), glow_ring))
    return bg


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--center", nargs=2, type=float, default=(0.5, 0.5), metavar=("X", "Y"))
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--glow", type=float, default=1.0)
    ap.add_argument("--out", default=OUT_DIR, help="輸出資料夾（預設 icons/）")
    a = ap.parse_args()
    out_dir = a.out

    src = Image.open(a.src)
    if src.mode in ("RGBA", "LA", "P"):
        src = src.convert("RGBA")
        flat = Image.new("RGB", src.size, COFFEE)
        flat.paste(src, mask=src.split()[-1])
        src = flat
    else:
        src = src.convert("RGB")

    photo = square_crop(src, a.center[0], a.center[1], a.zoom).resize((1024, 1024), Image.LANCZOS)
    master = compose(photo, 1024, 0.74, a.glow)       # 一般圖示
    mask_master = compose(photo, 1024, 0.60, a.glow)  # Android 可裁切圖示：主體在 80% 安全區內

    os.makedirs(out_dir, exist_ok=True)
    save = lambda im, name: im.save(os.path.join(out_dir, name), optimize=True)
    for sz in (512, 192):
        save(master.resize((sz, sz), Image.LANCZOS), f"icon-{sz}.png")
        save(mask_master.resize((sz, sz), Image.LANCZOS), f"icon-maskable-{sz}.png")
    save(master.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png")
    # 小尺寸 favicon 主體放大一點才看得清楚
    fav = compose(photo, 256, 0.86, a.glow)
    save(fav.resize((32, 32), Image.LANCZOS), "favicon-32.png")
    save(fav.resize((16, 16), Image.LANCZOS), "favicon-16.png")
    fav.resize((48, 48), Image.LANCZOS).save(os.path.join(out_dir, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("icons written to", os.path.normpath(out_dir))


if __name__ == "__main__":
    main()
