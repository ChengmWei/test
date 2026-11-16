#!/usr/bin/env python3
"""把一張真實鍋貼照片（PNG / JPG）轉成 PWA 所需的全部圖示，並加上金色發光效果。

用法：
    python3 tools/make_icons.py 原始照片.jpg
    python3 tools/make_icons.py 原始照片.png --center 0.5 0.55 --zoom 1.2 --glow 0.8

參數：
    --center X Y  鍋貼在照片中的中心位置（0~1，預設 0.5 0.5 = 正中央）
    --zoom Z      放大倍率，>1 會裁得更緊（預設 1.0）
    --glow G      發光強度 0~1.5（預設 0.8；照片本身已經發光可設 0.3）

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


def add_glow(img, strength):
    """金色發光：亮部泛光（bloom）+ 中央暖光 + 邊緣暗角。"""
    if strength <= 0:
        return img
    size = img.size[0]
    base = ImageEnhance.Contrast(img).enhance(1.06)
    base = ImageEnhance.Color(base).enhance(1.12)

    # 1) 亮部泛光：取亮部 → 大幅模糊 → 以 screen 疊回
    lum = base.convert("L").point(lambda v: max(0, v - 150) * 2.6)
    bloom_src = Image.composite(Image.new("RGB", (size, size), GOLD), Image.new("RGB", (size, size), (0, 0, 0)), lum)
    bloom = bloom_src.filter(ImageFilter.GaussianBlur(size * 0.045))
    bloom = ImageEnhance.Brightness(bloom).enhance(0.9 * strength)
    out = ImageChops.screen(base, bloom)

    # 2) 中央暖光光暈
    halo = radial(size, (int(GOLD[0] * 0.55), int(GOLD[1] * 0.42), int(GOLD[2] * 0.2)), (0, 0, 0), power=1.2)
    halo = ImageEnhance.Brightness(halo).enhance(0.75 * strength)
    out = ImageChops.screen(out, halo)

    # 3) 邊緣暗角，讓發光更聚焦
    vignette = radial(size, (255, 255, 255), (int(255 * (1 - 0.55 * min(strength, 1))),) * 3, power=2.2)
    out = ImageChops.multiply(out, vignette)

    # 4) 外圈細金邊光
    ring = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(ring)
    pad = size * 0.035
    d.ellipse((pad, pad, size - pad, size - pad), outline=255, width=max(1, int(size * 0.012)))
    ring = ring.filter(ImageFilter.GaussianBlur(size * 0.012))
    ring_rgb = Image.composite(Image.new("RGB", (size, size), GOLD), Image.new("RGB", (size, size), (0, 0, 0)), ring)
    out = ImageChops.screen(out, ImageEnhance.Brightness(ring_rgb).enhance(0.55 * strength))
    return out


def maskable(img, size):
    """Android 會把圖示裁成圓形／圓角等形狀；主體縮到 80% 安全區，外圍用模糊延伸補滿。"""
    bg = img.resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(size * 0.06))
    bg = ImageEnhance.Brightness(bg).enhance(0.55)
    inner = int(size * 0.80)
    fg = img.resize((inner, inner), Image.LANCZOS)
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, inner, inner), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(inner * 0.03))
    off = (size - inner) // 2
    bg.paste(fg, (off, off), mask)
    return bg


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--center", nargs=2, type=float, default=(0.5, 0.5), metavar=("X", "Y"))
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--glow", type=float, default=0.8)
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

    master = square_crop(src, a.center[0], a.center[1], a.zoom).resize((1024, 1024), Image.LANCZOS)
    master = add_glow(master, a.glow)

    os.makedirs(out_dir, exist_ok=True)
    save = lambda im, name: im.save(os.path.join(out_dir, name), optimize=True)
    for s in (512, 192):
        save(master.resize((s, s), Image.LANCZOS), f"icon-{s}.png")
        save(maskable(master, s), f"icon-maskable-{s}.png")
    save(master.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png")
    save(master.resize((32, 32), Image.LANCZOS), "favicon-32.png")
    save(master.resize((16, 16), Image.LANCZOS), "favicon-16.png")
    master.resize((48, 48), Image.LANCZOS).save(os.path.join(out_dir, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("icons written to", os.path.normpath(out_dir))


if __name__ == "__main__":
    main()
