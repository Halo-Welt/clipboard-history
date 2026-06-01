"""
将菜单栏图标处理成 macOS Template Image 格式：
- 黑色像素 -> 不透明黑色（前景）
- 白色背景 -> 完全透明
- 输出 16x16 / 32x32 (@2x) / 48x48 (@3x) 三个尺寸
- @2x / @3x 命名规则让 Electron 自动选择
"""
from PIL import Image
import os

src = '/Users/liuxinyutencent/.workbuddy/clipboard-images/clipboard-2026-06-01T05-51-22-773Z-8925068a.png'
out_dir = '/Users/liuxinyutencent/WorkBuddy/2026-06-01-13-01-50/build'

img = Image.open(src).convert('RGBA')
# 1. 居中裁剪到主体区域（图像中心 ~600x600 内）
w, h = img.size
print(f"原图尺寸: {w}x{h}")

# 主体在图像偏中下区域 - 自动找出非白色区域的边界框
gray = img.convert('L')
bbox = None
threshold = 200  # 灰度低于此值视为内容
pixels = gray.load()
min_x, min_y, max_x, max_y = w, h, 0, 0
for y in range(h):
    for x in range(w):
        if pixels[x, y] < threshold:
            if x < min_x: min_x = x
            if x > max_x: max_x = x
            if y < min_y: min_y = y
            if y > max_y: max_y = y
print(f"内容包围盒: ({min_x},{min_y}) -> ({max_x},{max_y})")

# 加 padding
pad = 60
crop = (max(0, min_x - pad), max(0, min_y - pad),
        min(w, max_x + pad), min(h, max_y + pad))
img = img.crop(crop)

# 2. 居中放到正方形画布上
side = max(img.size)
canvas = Image.new('RGBA', (side, side), (255, 255, 255, 0))
canvas.paste(img, ((side - img.size[0]) // 2, (side - img.size[1]) // 2))
img = canvas

# 3. 把"白色背景 -> 透明"，"非白色 -> 黑色不透明"
data = []
for r, g, b, a in img.getdata():
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    if luma < 220:
        # 前景：黑色 + 完全不透明
        data.append((0, 0, 0, 255))
    else:
        # 背景：完全透明
        data.append((0, 0, 0, 0))
img.putdata(data)

# 4. 输出三个尺寸（macOS tray template 推荐 16x16 base）
for size, suffix in [(16, ''), (32, '@2x'), (48, '@3x')]:
    resized = img.resize((size, size), Image.LANCZOS)
    # 重新二值化以保证清晰度（缩放后 alpha 可能变模糊）
    pixels = resized.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            if a > 80:
                pixels[x, y] = (0, 0, 0, 255)
            else:
                pixels[x, y] = (0, 0, 0, 0)
    out_path = os.path.join(out_dir, f'trayTemplate{suffix}.png')
    resized.save(out_path)
    print(f"✓ 写入 {out_path}")

print("Done.")
