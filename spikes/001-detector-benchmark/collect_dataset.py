#!/usr/bin/env python3
"""Capture labeled-by-review camera samples for the disposable benchmark."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


JPEG_START = b"\xff\xd8"
JPEG_END = b"\xff\xd9"


def capture_samples(output_dir: Path, label: str, count: int, interval: float, url: str) -> list[dict[str, object]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for index in range(count):
        captured_at = datetime.now(timezone.utc)
        stamp = captured_at.strftime("%Y%m%dT%H%M%S%fZ")
        filename = f"{label}-{stamp}-{index + 1:02d}.jpg"
        payload = urllib.request.urlopen(url, timeout=10).read()
        if not (payload.startswith(JPEG_START) and payload.endswith(JPEG_END)):
            raise RuntimeError(f"Resposta não parece JPEG: {filename}")
        (output_dir / filename).write_bytes(payload)
        rows.append(
            {
                "file": filename,
                "camera": "front",
                "oid": 1,
                "captured_at": captured_at.isoformat(),
                "source_url": "[REDACTED_LOCAL_ENDPOINT]",
                "label": None,
                "bytes": len(payload),
            }
        )
        if index + 1 < count:
            time.sleep(interval)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--label", choices=["positive", "negative"], required=True)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--url", default="http://127.0.0.1:8090/liveimage.jpg?oid=1")
    args = parser.parse_args()
    if args.count < 1 or args.interval < 0:
        raise SystemExit("count must be >= 1 and interval must be >= 0")
    rows = capture_samples(args.output_dir, args.label, args.count, args.interval, args.url)
    manifest = args.output_dir / "manifest.json"
    existing: list[dict[str, object]] = []
    if manifest.is_file():
        existing = json.loads(manifest.read_text(encoding="utf-8"))
    manifest.write_text(json.dumps(existing + rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"count": len(rows), "files": [row["file"] for row in rows]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
