import concurrent.futures
import io
import json
import random
import shutil
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parent.parent
BATCH = ROOT / '.runtime' / 'attraction-gallery-batch' / 'state.json'
OVERRIDES = ROOT / 'content' / 'attraction-gallery-overrides.json'
OUTPUT = ROOT / '.runtime' / 'attraction-gallery-audit'
SHEETS = OUTPUT / 'contact-sheets'
SAMPLE_RATIO = 0.5
SEED = '2026-09-08-gallery-50pct-audit'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def font(size):
    for candidate in [Path(r'C:\Windows\Fonts\msyh.ttc'), Path(r'C:\Windows\Fonts\simhei.ttf')]:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def image_urls(value):
    return [item if isinstance(item, str) else item.get('url', '') for item in value.get('images', [])]


def changed_ready_items(batch, current):
    output = []
    for item in batch.get('items', []):
        if item.get('status') != 'ready_for_user_review':
            continue
        selected = [candidate.get('url', '') for candidate in item.get('selected', [])]
        if selected != image_urls(current.get(item.get('id'), {})):
            output.append(item)
    return output


def probe_remote(url):
    if url.startswith('/'):
        path = ROOT / url.lstrip('/')
        return {'ok': path.is_file(), 'status': 'local', 'contentType': '', 'error': '' if path.is_file() else 'missing local file'}
    headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Range': 'bytes=0-4095',
    }
    last_error = ''
    for _ in range(2):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=5) as response:
                content_type = response.headers.get('Content-Type', '')
                response.read(64)
                ok = response.status in (200, 206) and ('image/' in content_type or 'octet-stream' in content_type)
                return {'ok': ok, 'status': response.status, 'contentType': content_type, 'error': '' if ok else 'non-image response'}
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            last_error = str(error)
    return {'ok': False, 'status': 0, 'contentType': '', 'error': last_error}


def make_thumb(path, width=210, height=126):
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        scale = max(width / image.width, height / image.height)
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        left = max(0, (image.width - width) // 2)
        top = max(0, (image.height - height) // 2)
        return image.crop((left, top, left + width, top + height))


def render_sheets(sample):
    shutil.rmtree(SHEETS, ignore_errors=True)
    SHEETS.mkdir(parents=True, exist_ok=True)
    title_font = font(22)
    label_font = font(16)
    small_font = font(12)
    rows_per_sheet = 12
    sheet_paths = []
    for sheet_index, start in enumerate(range(0, len(sample), rows_per_sheet), 1):
        subset = sample[start:start + rows_per_sheet]
        canvas = Image.new('RGB', (1400, 1940), '#f4f7fb')
        draw = ImageDraw.Draw(canvas)
        draw.text((24, 14), f'Gallery random audit 50% - {sheet_index:02d}', fill='#111827', font=title_font)
        for row, item in enumerate(subset):
            y = 55 + row * 156
            draw.text((20, y + 8), str(item.get('name', ''))[:15], fill='#111827', font=label_font)
            draw.text((20, y + 35), f"{item.get('province', '')} / {item.get('city', '')}", fill='#64748b', font=small_font)
            for col, candidate in enumerate(item.get('selected', [])):
                x = 270 + col * 224
                try:
                    canvas.paste(make_thumb(ROOT / candidate['reviewFile']), (x, y))
                    draw.text((x, y + 130), f"{col + 1} {candidate.get('source', '')}", fill='#334155', font=small_font)
                except Exception:
                    draw.rectangle((x, y, x + 210, y + 126), fill='#ef4444')
                    draw.text((x + 8, y + 48), 'MISSING', fill='white', font=label_font)
        path = SHEETS / f'audit-{sheet_index:02d}.jpg'
        canvas.save(path, quality=90)
        sheet_paths.append(path.relative_to(ROOT).as_posix())
    return sheet_paths


def main():
    batch = read_json(BATCH)
    current = read_json(OVERRIDES)
    population = changed_ready_items(batch, current)
    sample_size = round(len(population) * SAMPLE_RATIO)
    sample = random.Random(SEED).sample(population, sample_size)
    tasks = [(item, candidate) for item in sample for candidate in item.get('selected', [])]
    probes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=48) as executor:
        future_map = {executor.submit(probe_remote, candidate['url']): (item, candidate) for item, candidate in tasks}
        for completed, future in enumerate(concurrent.futures.as_completed(future_map), 1):
            item, candidate = future_map[future]
            probes[f"{item['id']}\0{candidate['url']}"] = future.result()
            if completed % 100 == 0 or completed == len(tasks):
                print(f'online-check {completed}/{len(tasks)}', flush=True)
    issues = []
    source_counts = Counter()
    image_count = 0
    for item in sample:
        for candidate in item.get('selected', []):
            image_count += 1
            source_counts[candidate.get('source', 'unknown')] += 1
            dimensions = candidate.get('dimensions') or {}
            long_side = max(int(dimensions.get('width', 0)), int(dimensions.get('height', 0)))
            short_side = min(int(dimensions.get('width', 0)), int(dimensions.get('height', 0)))
            if long_side < 1000 or short_side < 560:
                issues.append({'id': item['id'], 'name': item['name'], 'url': candidate['url'], 'kind': 'resolution', 'detail': dimensions})
            result = probes[f"{item['id']}\0{candidate['url']}"]
            if not result['ok']:
                issues.append({'id': item['id'], 'name': item['name'], 'url': candidate['url'], 'kind': 'availability', 'detail': result})
    sheets = render_sheets(sample)
    report = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'seed': SEED,
        'population': len(population),
        'sampleRatio': SAMPLE_RATIO,
        'sampleSize': len(sample),
        'imageCount': image_count,
        'sourceCounts': dict(source_counts),
        'automaticIssueCount': len(issues),
        'issues': issues,
        'contactSheets': sheets,
        'sample': [{'id': item['id'], 'name': item['name'], 'province': item.get('province', ''), 'city': item.get('city', ''), 'count': len(item.get('selected', []))} for item in sample],
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('population', 'sampleSize', 'imageCount', 'sourceCounts', 'automaticIssueCount')}, ensure_ascii=False, indent=2))
    print(f'contactSheets={len(sheets)} report={OUTPUT / "report.json"}')


if __name__ == '__main__':
    main()
