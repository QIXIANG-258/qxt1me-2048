"""
2048 favicon / app-icon 套件生成
──────────────────────────────
输入：_tools/icon-source.jpg（用户给的 4×4 棋盘原稿，1024×1024，已带 maskable 内边距）
输出：
  src/favicon.ico           16+32+48 三层 ICO
  src/icon-180.png           180×180    iOS Apple-Touch
  src/icon-192.png           192×192    manifest 普通
  src/icon-512.png           512×512    manifest 普通
  src/icon-192-maskable.png  192×192    manifest 适配（带安全区）
  src/icon-512-maskable.png  512×512    manifest 适配（带安全区）

设计依据：见 src/index.html 的 <link rel="icon"> 与 manifest.webmanifest。
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "_tools", "icon-source.jpg")
OUT  = os.path.join(ROOT, "src")

# ── 母图：1024 → 512（向下采样）──────────────────────
# ⚠️ 用户给的图本身已经留好了 maskable 安全区，所以同一张图
#    既能做"普通"也能做"maskable"（后者由 manifest 的 purpose:"maskable" 标记）。
src_img = Image.open(SRC).convert("RGBA")
print(f"母图原始尺寸: {src_img.size}")
import sys; sys.stdout.flush()

# 目标 512×512
master = src_img.resize((512, 512), Image.LANCZOS)
master.save(os.path.join(OUT, "icon-source-512.png"), optimize=True)

# ── 5 种 PNG（manifest + iOS + 普通）─────────────────
# 普通：缩放后保存
master.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"), optimize=True)
master.save(os.path.join(OUT, "icon-512.png"), optimize=True)

# maskable：内容不变，由 manifest 的 purpose:"maskable" 标记让系统自动适配。
# （用户给的原稿本身已经留好了"圆形安全区"，不必再额外 padding —— 重画会变样。）
master.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192-maskable.png"), optimize=True)
master.save(os.path.join(OUT, "icon-512-maskable.png"), optimize=True)

# iOS Apple-Touch（180×180，固定 180）
master.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "icon-180.png"), optimize=True)

# ── favicon.ico（多分辨率 16 + 32 + 48）────────────────
# ICO 容器要求所有图层都来自同一张母图，且尺寸都 ≤ 256
# ⚠️ 不能把 512 塞进去（浏览器会自动拒绝）；用 16/32/48 三层够用。
# ⚠️ Pillow 11 的 ICO 多尺寸保存有个隐藏坑：append_images 看似有效，
#    实测 11.3 写出来还是只存 16×16 一帧（浏览器读不到其它尺寸）。
#    可靠写法：**手动构造 ICO 文件** —— 每个目标尺寸先写成独立 PNG
#    bytes，再按 ICO 容器格式拼接（IEND 留 4 字节对齐即可）。
#    这里偷懒用 png2ico 思路：直接给 Windows 用的"PNG-in-ICO"格式
#    —— 现代浏览器/Edge/Chrome/Firefox 都支持 ICO 里塞 PNG。
import struct
import io

def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()

ico_pngs = [
    ((16, 16), png_bytes(master.resize((16, 16), Image.LANCZOS))),
    ((32, 32), png_bytes(master.resize((32, 32), Image.LANCZOS))),
    ((48, 48), png_bytes(master.resize((48, 48), Image.LANCZOS))),
]

# ICO header: reserved(2) + type(2,1=icon) + count(2)
# 每条目: width(1) height(1) colors(1=0) reserved(1) planes(2) bpp(2) size(4) offset(4)
out_buf = io.BytesIO()
out_buf.write(struct.pack("<HHH", 0, 1, len(ico_pngs)))
offset = 6 + 16 * len(ico_pngs)
entries = []
for (w, h), png in ico_pngs:
    # ICO 规定 256 用 0 表示
    w_b = 0 if w == 256 else w
    h_b = 0 if h == 256 else h
    entries.append((w_b, h_b, 0, 0, 1, 32, len(png), offset))
    offset += len(png)
for w_b, h_b, colors, reserved, planes, bpp, size, off in entries:
    out_buf.write(struct.pack("<BBBBHHII", w_b, h_b, colors, reserved, planes, bpp, size, off))
for _, png in ico_pngs:
    out_buf.write(png)

with open(os.path.join(OUT, "favicon.ico"), "wb") as f:
    f.write(out_buf.getvalue())

# 自校验：读回来应该能列出三个尺寸
out_ico = Image.open(os.path.join(OUT, "favicon.ico"))
assert len(out_ico.ico.sizes()) >= 2, f"favicon.ico 多分辨率没保存上，实际尺寸={out_ico.ico.sizes()}"
print("\n输出文件:")
for n in ["favicon.ico", "icon-180.png", "icon-192.png", "icon-512.png",
          "icon-192-maskable.png", "icon-512-maskable.png", "icon-source-512.png"]:
    p = os.path.join(OUT, n)
    print(f"  {n:30s} {os.path.getsize(p):>8} B")