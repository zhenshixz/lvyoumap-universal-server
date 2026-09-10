"""Bounded, uncropped contact sheets from the isolated audit snapshot."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

root = Path(__file__).resolve().parent.parent
runtime = root / '.runtime' / 'attraction-gallery-batch'
data = json.loads((runtime / 'codex-audit.json').read_text(encoding='utf-8'))
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 15)
for offset in range(0, len(data['items']), 5):
    canvas = Image.new('RGB', (1400, 1000), 'white')
    draw = ImageDraw.Draw(canvas)
    for row, item in enumerate(data['items'][offset:offset + 5]):
        y = row * 200
        draw.text((8, y + 8), f"{offset + row + 1}. {item['name']} ({item['province']} {item['city']})", font=font, fill='black')
        for col, im in enumerate(item['selected']):
            with Image.open(root / im['reviewFile']) as image:
                thumb = ImageOps.contain(image.convert('RGB'), (270, 155))
            canvas.paste(thumb, (col * 280 + 4, y + 35))
    canvas.save(runtime / f'codex-audit-sheet-{offset // 5 + 1}.jpg', quality=83)
print('6 bounded sheets ready; source images unchanged')
