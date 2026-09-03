import json
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageStat

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime' / 'attraction-gallery-pilot'

# 视觉抽查确认的非景点主体图片。这里只记录确定错图；后续不足 5 张会由
# --repair-shortages 定点补图，不会因此重跑整个批次。
BLOCKED_URL_PARTS = {
    '311209b13c3e95d3772b13db68a1f50c',  # 东方明珠集团公司门牌
    '176927614820_1769276173220_48034686',  # 海口钟楼文保牌
    '2007_Shanghai_Disney_Resort',  # 上海迪士尼历史地图/网页截图
    'train_interior_of_Line_11',  # 上海地铁 11 号线车厢，并非景区实景
    '699pic.com',  # 摄图网搜索预览图自带水印
    'nipic.com',  # 昵图网搜索预览图自带水印
    'vcg.com',  # 视觉中国搜索预览图可能带水印
    'quanjing.com',  # 全景视觉搜索预览图可能带水印
}
MANIFEST = RUNTIME / 'manifest.json'
OUTPUT = RUNTIME / 'contact-sheets'


def font(size):
    candidates = [Path(r'C:\Windows\Fonts\msyh.ttc'), Path(r'C:\Windows\Fonts\simhei.ttf')]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def crop_thumb(image, width=250, height=150):
    image = image.convert('RGB')
    ratio = max(width / image.width, height / image.height)
    image = image.resize((round(image.width * ratio), round(image.height * ratio)))
    left = max(0, (image.width - width) // 2)
    top = max(0, (image.height - height) // 2)
    return image.crop((left, top, left + width, top + height))


def visual_stats(path):
    with Image.open(path) as image:
        gray = image.convert('L').resize((96, 96))
        stat = ImageStat.Stat(gray)
        mean = stat.mean[0]
        dark_ratio = sum(1 for pixel in gray.getdata() if pixel < 35) / (96 * 96)
        return mean, dark_ratio


def main():
    data = json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    title_font = font(22)
    label_font = font(15)
    small_font = font(12)
    selected = {}

    for item in data['items']:
        accepted = []
        hashes = []
        for candidate in item.get('qualified', []):
            if any(part in candidate.get('url', '') for part in BLOCKED_URL_PARTS):
                continue
            path = ROOT / candidate['reviewFile']
            try:
                mean, dark_ratio = visual_stats(path)
                with Image.open(path) as image:
                    tiny = image.convert('L').resize((9, 8))
                    pixels = list(tiny.getdata())
                    value = sum((1 << index) for index in range(64) if pixels[index] > pixels[index + 1])
                if mean < 42 or dark_ratio > 0.62:
                    continue
                if any((value ^ old).bit_count() <= 7 for old in hashes):
                    continue
                candidate['visualQuality'] = {'meanBrightness': round(mean, 1), 'darkRatio': round(dark_ratio, 3)}
                accepted.append(candidate)
                hashes.append(value)
            except Exception:
                continue
        selected[item['id']] = accepted[:5]
        item['selected'] = accepted[:5]

    (RUNTIME / 'selected.json').write_text(json.dumps(selected, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    for sheet_index in range(math.ceil(len(data['items']) / 5)):
        subset = data['items'][sheet_index * 5:(sheet_index + 1) * 5]
        canvas = Image.new('RGB', (1380, 920), '#f4f7fb')
        draw = ImageDraw.Draw(canvas)
        draw.text((30, 18), f'图库试点质量抽查 {sheet_index + 1}/4', fill='#0f172a', font=title_font)
        for row, item in enumerate(subset):
            y = 70 + row * 168
            draw.text((30, y + 8), item['name'], fill='#0f172a', font=label_font)
            draw.text((30, y + 38), f"{item['province']} · {item['city']}", fill='#64748b', font=small_font)
            for col, candidate in enumerate(item.get('selected', [])[:5]):
                x = 190 + col * 235
                try:
                    with Image.open(ROOT / candidate['reviewFile']) as image:
                        thumb = crop_thumb(image, 220, 132)
                    canvas.paste(thumb, (x, y))
                    draw.text((x, y + 136), f"{col + 1} {candidate['source']}", fill='#334155', font=small_font)
                except Exception:
                    draw.rectangle((x, y, x + 220, y + 132), fill='#cbd5e1')
        canvas.save(OUTPUT / f'gallery-pilot-{sheet_index + 1}.jpg', quality=88)
    print(f'已生成 {len(data["items"])} 个景点的筛选结果与 4 张联系表。')


if __name__ == '__main__':
    main()
