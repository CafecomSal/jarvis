#!/usr/bin/env python3
"""Capture a labeled-by-review dataset directly from an RTSP camera."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path


JPEG_START = b"\xff\xd8"
JPEG_END = b"\xff\xd9"


def capture_rtsp_frame(
    stream_url: str,
    *,
    transport: str = "udp",
    ffmpeg_path: str = "ffmpeg",
    timeout: float = 10,
) -> bytes:
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        transport,
        "-i",
        stream_url,
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "pipe:1",
    ]
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("FFmpeg timed out while capturing the RTSP frame") from exc
    except OSError as exc:
        raise RuntimeError("FFmpeg could not start for the RTSP camera") from exc

    if completed.returncode != 0:
        raise RuntimeError("FFmpeg could not capture an RTSP frame")
    payload = completed.stdout
    if not (payload.startswith(JPEG_START) and payload.endswith(JPEG_END)):
        raise RuntimeError("RTSP capture did not return a valid JPEG frame")
    return payload


def capture_samples(
    output_dir: Path,
    label: str,
    count: int,
    interval: float,
    capture: Callable[[], bytes],
    camera: str = "front",
) -> list[dict[str, object]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for index in range(count):
        captured_at = datetime.now(timezone.utc)
        stamp = captured_at.strftime("%Y%m%dT%H%M%S%fZ")
        filename = f"{label}-{stamp}-{index + 1:02d}.jpg"
        payload = capture()
        (output_dir / filename).write_bytes(payload)
        rows.append(
            {
                "file": filename,
                "camera": camera,
                "source": "rtsp",
                "captured_at": captured_at.isoformat(),
                "source_url": "[REDACTED_RTSP_URL]",
                "label": None,
                "bytes": len(payload),
            }
        )
        if index + 1 < count:
            time.sleep(interval)
    manifest = output_dir / "manifest.json"
    existing: list[dict[str, object]] = []
    if manifest.is_file():
        existing = json.loads(manifest.read_text(encoding="utf-8"))
    manifest.write_text(
        json.dumps(existing + rows, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return rows


def camera_env_name(camera: str) -> str:
    normalized = "".join(character if character.isalnum() else "_" for character in camera).upper()
    return f"JARVIS_CAMERA_{normalized}_RTSP_URL"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--label", choices=["positive", "negative"], required=True)
    parser.add_argument("--camera", default="front")
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--transport", choices=["udp", "tcp"], default=os.environ.get("JARVIS_RTSP_TRANSPORT", "udp"))
    parser.add_argument("--ffmpeg-path", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    if args.count < 1 or args.interval < 0 or args.timeout <= 0:
        raise SystemExit("count must be >= 1, interval must be >= 0, and timeout must be > 0")

    stream_env = camera_env_name(args.camera)
    stream_url = os.environ.get(stream_env, "").strip()
    if not stream_url:
        raise SystemExit(f"{stream_env} must be configured in the local environment")

    rows = capture_samples(
        args.output_dir,
        args.label,
        args.count,
        args.interval,
        lambda: capture_rtsp_frame(
            stream_url,
            transport=args.transport,
            ffmpeg_path=args.ffmpeg_path,
            timeout=args.timeout,
        ),
        camera=args.camera,
    )
    print(json.dumps({"count": len(rows), "files": [row["file"] for row in rows]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
