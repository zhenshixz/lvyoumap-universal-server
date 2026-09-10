"""Incrementally shrink review caches only; keep all external URLs and source dimensions."""
import hashlib
import json
import time
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parent.parent
runtime = root / '.runtime' / 'attraction-gallery-batch'
file = runtime / 'state.json'
state = json.loads(file.read_text(encoding='utf-8-sig'))
refs = {}
for item in state['items']:
    for key in ('qualified', 'selected'):
        for image in item.get(key, []):
            if image.get('reviewFile'):
                refs.setdefault(image['reviewFile'], []).append(image)
count = 0
started = time.monotonic()
for relative, images in refs.items():
    if count >= 80 or time.monotonic() - started > 10:
        break
    if all(im.get('reviewCompacted') for im in images):
        continue
    source = (root / relative).resolve()
    if not source.is_relative_to((runtime / 'images').resolve()) or not source.exists():
        continue
    try:
        with Image.open(source) as im:
            thumb = ImageOps.exif_transpose(im).convert('RGB')
            thumb.thumbnail((960, 720), Image.Resampling.LANCZOS)
        temp = source.with_suffix(source.suffix + '.tmp')
        thumb.save(temp, 'JPEG', quality=85)
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        temp.replace(source)
        for im in images:
            im['reviewCompacted'] = True
            im['reviewHash'] = digest
        count += 1
    except Exception as error:
        print('Cache skipped:', source.name, str(error))
temp = file.with_suffix('.compact.tmp')
temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
temp.replace(file)
print('Review caches compacted:', count)
