import json
import sys
from pathlib import Path
from PIL import Image, ImageOps
from render_attraction_gallery_batch import visual_ok

# Only files created by this isolated batch are eligible for cleanup.
manifest = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parent.parent
manifest.relative_to(root / '.runtime' / 'gallery-link-batches' / 'runs')
data = json.loads(manifest.read_text(encoding='utf-8'))
hashes = []
for item in data:
    if not item.get('raw'):
        continue
    source = (manifest.parent / item['raw']).resolve()
    source.relative_to(manifest.parent / 'raw')
    if not source.exists():
        if item.get('accepted') and item.get('hashes'):
            hashes.append(tuple(item['hashes']))
        continue
    try:
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original).convert('RGB')
            w, h = image.size
            item['dimensions'] = [w, h]
            ok, values, reason = visual_ok(source, hashes)
            item.update(accepted=ok, reason=reason, hashes=list(values))
            if ok:
                hashes.append(values)
                target = manifest.parent / 'candidates' / source.name
                target.parent.mkdir(exist_ok=True)
                image.thumbnail((2500, 2500))
                image.save(target, quality=88, optimize=True)
                item['file'] = 'candidates/' + source.name
                image.thumbnail((480, 320))
                thumb = manifest.parent / 'thumbs' / source.name
                thumb.parent.mkdir(exist_ok=True)
                image.save(thumb, quality=78, optimize=True)
                item['thumb'] = 'thumbs/' + source.name
    except Exception as e:
        item.update(accepted=False, reason='无法解码图片: ' + type(e).__name__)
    # Persist references before deleting this batch's unreferenced raw download.
    temp = manifest.with_suffix('.qa.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(manifest)
    source.unlink(missing_ok=True)
print(json.dumps({'candidates': sum(bool(x.get('accepted')) for x in data)}))
