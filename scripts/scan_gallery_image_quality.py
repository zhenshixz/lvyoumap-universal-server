from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2


ROOT = Path(__file__).resolve().parents[1]
STATE_FILE = ROOT / ".runtime" / "attraction-gallery-batch" / "state.json"
RUNS_DIR = ROOT / ".runtime" / "gallery-link-batches" / "runs"
OUTPUT_FILE = ROOT / ".runtime" / "gallery-link-batches" / "image-quality-scan.json"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def candidates():
    states = [read_json(STATE_FILE, {})]
    if RUNS_DIR.exists():
        states.extend(read_json(path, {}) for path in RUNS_DIR.glob("*/state.json"))
    by_url = {}
    for state in states:
        for item in state.get("items", []):
            for image in [*(item.get("selected") or []), *(item.get("images") or [])]:
                url = image.get("url")
                review_file = image.get("reviewFile")
                if not url or not review_file:
                    continue
                file = (ROOT / review_file).resolve()
                try:
                    file.relative_to(ROOT / ".runtime")
                except ValueError:
                    continue
                if file.is_file():
                    by_url[url] = file
    return by_url


def inspect(entry):
    url, file = entry
    image = cv2.imread(os.fspath(file), cv2.IMREAD_COLOR)
    if image is None:
        return url, {"error": "图片无法解码"}
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    scale = min(1.0, 640 / max(width, height))
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    clipping = float(((gray < 12) | (gray > 243)).mean())
    return url, {
        "width": width,
        "height": height,
        "sharpness": round(sharpness, 1),
        "brightness": round(brightness, 1),
        "clipping": round(clipping, 3),
    }


def main():
    files = candidates()
    workers = min(12, max(2, (os.cpu_count() or 4)))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        metrics = dict(executor.map(inspect, files.items()))
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps({
        "version": 1,
        "scannedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "count": len(metrics),
        "metrics": metrics,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(OUTPUT_FILE)
    print(json.dumps({"scanned": len(metrics), "file": str(OUTPUT_FILE.relative_to(ROOT))}))


if __name__ == "__main__":
    main()
