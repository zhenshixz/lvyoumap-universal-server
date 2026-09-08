import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime' / 'attraction-gallery-batch'
STATE = RUNTIME / 'state.json'
IMAGES = RUNTIME / 'images'
NEXT = RUNTIME / 'images.next'
PREVIOUS = RUNTIME / 'images.previous'


def main():
    if not STATE.exists() or not IMAGES.exists():
        print('没有需要压缩的图库审图缓存。')
        return
    data = json.loads(STATE.read_text(encoding='utf-8-sig'))
    references = {}
    for item in data.get('items', []):
        for section in ('qualified', 'selected'):
            for candidate in item.get(section, []):
                review_file = candidate.get('reviewFile')
                if review_file:
                    references.setdefault(review_file, []).append(candidate)

    shutil.rmtree(NEXT, ignore_errors=True)
    NEXT.mkdir(parents=True, exist_ok=True)
    compacted = 0
    missing = 0
    for relative, candidates in references.items():
        source = ROOT / relative
        if not source.exists():
            missing += 1
            continue
        target = NEXT / f"{candidates[0].get('hash') or hashlib.sha256(relative.encode()).hexdigest()}.jpg"
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((720, 540), Image.Resampling.LANCZOS)
            image.save(target, 'JPEG', quality=82, optimize=True)
        payload = target.read_bytes()
        review_hash = hashlib.sha256(payload).hexdigest()
        new_relative = target.relative_to(ROOT).as_posix().replace('images.next/', 'images/')
        for candidate in candidates:
            candidate['reviewFile'] = new_relative
            candidate['reviewCompacted'] = True
            candidate['reviewHash'] = review_hash
        compacted += 1

    temporary = STATE.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    shutil.rmtree(PREVIOUS, ignore_errors=True)
    IMAGES.replace(PREVIOUS)
    NEXT.replace(IMAGES)
    temporary.replace(STATE)
    shutil.rmtree(PREVIOUS, ignore_errors=True)
    size_mb = sum(file.stat().st_size for file in IMAGES.rglob('*') if file.is_file()) / 1024 / 1024
    print(f'审图缓存已压缩：{compacted} 个唯一文件，缺失 {missing} 个，当前 {size_mb:.2f} MB。')


if __name__ == '__main__':
    main()
