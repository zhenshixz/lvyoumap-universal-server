import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageStat

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime' / 'attraction-gallery-batch'
STATE = RUNTIME / 'state.json'
OUTPUT = RUNTIME / 'contact-sheets'
DENYLIST = ROOT / 'content' / 'attraction-gallery-image-denylist.json'
POLICY = ROOT / 'content' / 'attraction-gallery-policy.json'


def font(size):
    for candidate in [Path(r'C:\Windows\Fonts\msyh.ttc'), Path(r'C:\Windows\Fonts\simhei.ttf')]:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def crop(image, width=210, height=126):
    image = image.convert('RGB')
    scale = max(width / image.width, height / image.height)
    image = image.resize((round(image.width * scale), round(image.height * scale)))
    left = max(0, (image.width - width) // 2)
    top = max(0, (image.height - height) // 2)
    return image.crop((left, top, left + width, top + height))


def dhash(image):
    pixels = list(image.convert('L').resize((9, 8)).get_flattened_data())
    return sum((1 << (row * 8 + col)) for row in range(8) for col in range(8)
               if pixels[row * 9 + col] > pixels[row * 9 + col + 1])


def phash(image):
    gray = np.asarray(image.convert('L').resize((32, 32)), dtype=np.float32)
    transformed = cv2.dct(gray)[:8, :8]
    values = transformed.flatten()[1:]
    median = float(np.median(values))
    return sum((1 << i) for i, value in enumerate(values) if value > median)


def visual_ok(path, hashes):
    with Image.open(path) as image:
        gray = image.convert('L').resize((96, 96))
        stat = ImageStat.Stat(gray)
        mean = stat.mean[0]
        dark = sum(1 for value in gray.get_flattened_data() if value < 30) / (96 * 96)
        value = (dhash(image), phash(image))
    if mean < 38 or dark > 0.66:
        return False, value, '画面过暗'
    if any((value[0] ^ old[0]).bit_count() <= 8 or (value[1] ^ old[1]).bit_count() <= 10 for old in hashes):
        return False, value, '近似重复图'
    return True, value, ''


def main():
    data = json.loads(STATE.read_text(encoding='utf-8-sig'))
    policy = json.loads(POLICY.read_text(encoding='utf-8-sig'))
    minimum = int(policy['minimumImages'])
    maximum = int(policy['maximumImages'])
    if not 1 <= minimum <= int(policy['targetImages']) <= maximum:
        raise ValueError('图库规则无效：必须满足 minimumImages <= targetImages <= maximumImages')
    data['version'] = max(6, int(data.get('version', 0)))
    data['galleryPolicy'] = policy
    data['rule'] = policy['rule']
    denied = {
        item['url'] for item in json.loads(DENYLIST.read_text(encoding='utf-8-sig'))
    } if DENYLIST.exists() else set()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT.glob('gallery-batch-*.jpg'):
        old.unlink()
    ready = []
    for item in data['items']:
        if item.get('status', '').startswith('excluded_'):
            continue
        if item.get('status') == 'ready_for_user_review' and minimum <= len(item.get('selected', [])) <= maximum:
            if all(candidate.get('url') not in denied and (ROOT / candidate['reviewFile']).exists()
                   for candidate in item['selected']):
                ready.append(item)
                continue
        selected = []
        hashes = []
        item['visualRejected'] = []
        for candidate in item.get('qualified', []):
            if candidate.get('url') in denied:
                continue
            path = ROOT / candidate['reviewFile']
            try:
                ok, value, reason = visual_ok(path, hashes)
                if not ok:
                    item['visualRejected'].append({'url': candidate['url'], 'reason': reason})
                    continue
                hashes.append(value)
                selected.append(candidate)
            except Exception as error:
                item['visualRejected'].append({'url': candidate['url'], 'reason': str(error)})
                continue
        item['selected'] = selected[:maximum]
        item['status'] = 'ready_for_user_review' if len(item['selected']) >= minimum else 'pending_sources'
        if len(item['selected']) >= minimum:
            ready.append(item)
    temporary = STATE.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(STATE)

    title = font(20)
    label = font(14)
    small = font(11)
    per_sheet = 6
    for sheet_index in range(math.ceil(len(ready) / per_sheet)):
        subset = ready[sheet_index * per_sheet:(sheet_index + 1) * per_sheet]
        canvas = Image.new('RGB', (1320, 1000), '#f4f7fb')
        draw = ImageDraw.Draw(canvas)
        draw.text((24, 16), f'全国图库稳定来源抽查（{minimum}-{maximum}张） {sheet_index + 1}/{math.ceil(len(ready) / per_sheet)}', fill='#0f172a', font=title)
        for row, item in enumerate(subset):
            y = 58 + row * 154
            draw.text((24, y + 6), item['name'][:12], fill='#0f172a', font=label)
            draw.text((24, y + 34), f"{item['province']} · {item['city']}", fill='#64748b', font=small)
            for col, candidate in enumerate(item['selected']):
                x = 180 + col * 224
                try:
                    with Image.open(ROOT / candidate['reviewFile']) as image:
                        thumb = crop(image)
                    canvas.paste(thumb, (x, y))
                    draw.text((x, y + 130), f"{col + 1} {candidate['source']}", fill='#334155', font=small)
                except Exception:
                    draw.rectangle((x, y, x + 210, y + 126), fill='#cbd5e1')
        canvas.save(OUTPUT / f'gallery-batch-{sheet_index + 1:02d}.jpg', quality=88)
    print(f"视觉筛选完成：{len(data['items'])} 个中 {len(ready)} 个达到 {minimum}-{maximum} 张；生成 {math.ceil(len(ready) / per_sheet)} 张联系表。")


if __name__ == '__main__':
    main()
