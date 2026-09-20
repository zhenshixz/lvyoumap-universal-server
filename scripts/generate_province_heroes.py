from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SELECTIONS_FILE = ROOT / ".runtime" / "province-hero-review" / "selections.json"
INDEX_FILE = ROOT / "data" / "provinces-index.json"
CONFIG_FILE = ROOT / "content" / "province-heroes.json"
OUTPUT_DIR = ROOT / "assets" / "images" / "province-heroes"
CACHE_DIR = ROOT / ".runtime" / "province-hero-review" / "source-cache"
VARIANTS = {
    "desktop": (1920, 60 / 13),
    "tablet": (1600, 60 / 13),
    "mobile": (960, 50 / 13),
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def source_bytes(url: str) -> bytes:
    if url.startswith("/"):
        source = (ROOT / url.lstrip("/")).resolve()
        allowed = (ROOT / "assets" / "images").resolve()
        if allowed not in source.parents or not source.is_file():
            raise RuntimeError(f"Invalid local image: {url}")
        return source.read_bytes()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{hashlib.sha256(url.encode()).hexdigest()}.img"
    if cache.is_file() and cache.stat().st_size > 1024:
        return cache.read_bytes()
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
            "Referer": "https://hk.trip.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(40 * 1024 * 1024 + 1)
    if len(data) < 1024 or len(data) > 40 * 1024 * 1024:
        raise RuntimeError(f"Unexpected remote image size: {url}")
    cache.write_bytes(data)
    return data


def crop_for_banner(image: Image.Image, ratio: float, focus_x: int, focus_y: int) -> Image.Image:
    width, height = image.size
    if width / height > ratio:
        crop_width = round(height * ratio)
        left = round((width - crop_width) * focus_x / 100)
        box = (left, 0, left + crop_width, height)
    else:
        crop_height = round(width / ratio)
        top = round((height - crop_height) * focus_y / 100)
        box = (0, top, width, top + crop_height)
    return image.crop(box)


def generate() -> None:
    selections = read_json(SELECTIONS_FILE).get("selections", {})
    index = read_json(INDEX_FILE)
    if len(selections) != len(index) or set(selections) != set(index):
        missing = sorted(set(index) - set(selections))
        raise RuntimeError(f"Expected all {len(index)} selections; missing: {', '.join(missing)}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "items": {}}
    for province, item in index.items():
        selected = selections[province]
        raw = source_bytes(selected["url"])
        with Image.open(BytesIO(raw)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        generated = {}
        for variant, (target_width, ratio) in VARIANTS.items():
            cropped = crop_for_banner(image, ratio, int(selected.get("focusX", 50)), int(selected.get("focusY", 50)))
            output_width = min(target_width, cropped.width)
            output_height = round(output_width / ratio)
            if cropped.size != (output_width, output_height):
                cropped = cropped.resize((output_width, output_height), Image.Resampling.LANCZOS)
            filename = f"{item['id']}-{selected['candidateId']}-{variant}.webp"
            output = OUTPUT_DIR / filename
            temp = output.with_suffix(".tmp")
            cropped.save(temp, "WEBP", quality=88, method=6)
            os.replace(temp, output)
            generated[variant] = f"/assets/images/province-heroes/{filename}"

        item["image"] = generated["desktop"]
        item["hero"] = {
            **generated,
            "focusX": int(selected.get("focusX", 50)),
            "focusY": int(selected.get("focusY", 50)),
            "sourceAttraction": selected.get("attractionName", ""),
            "source": selected.get("source", ""),
        }
        manifest["items"][province] = item["hero"]

    temp_index = INDEX_FILE.with_suffix(".json.tmp")
    temp_index.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temp_index, INDEX_FILE)
    CONFIG_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {len(index)} province hero sets ({len(index) * len(VARIANTS)} files).")


if __name__ == "__main__":
    generate()
