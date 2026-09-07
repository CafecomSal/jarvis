from __future__ import annotations

import base64
import json
import sys
import time

from rapidocr_onnxruntime import RapidOCR


def flatten_box(points: object) -> dict[str, float]:
    coordinates = [
        (float(point[0]), float(point[1]))
        for point in points  # type: ignore[union-attr]
    ]
    xs = [point[0] for point in coordinates]
    ys = [point[1] for point in coordinates]
    return {
        "x1": min(xs),
        "y1": min(ys),
        "x2": max(xs),
        "y2": max(ys),
    }


def main() -> None:
    engine = RapidOCR()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            image = base64.b64decode(request["imageBase64"], validate=True)
            started = time.perf_counter()
            raw_result, _timings = engine(image)
            regions = []
            for item in raw_result or []:
                box, text, confidence = item
                text_value = str(text).strip()
                if not text_value:
                    continue
                regions.append(
                    {
                        "text": text_value,
                        "confidence": float(confidence),
                        "box": flatten_box(box),
                    }
                )
            print(
                json.dumps(
                    {
                        "latencyMs": (time.perf_counter() - started) * 1000.0,
                        "regions": regions,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as error:  # pragma: no cover - exercised by process smoke
            print(f"RapidOCR worker failed: {error}", file=sys.stderr, flush=True)
            raise SystemExit(1) from error


if __name__ == "__main__":
    main()
