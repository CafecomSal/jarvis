#!/usr/bin/env python3
"""Collect a short Frigate CPU-detector stats window."""

from __future__ import annotations

import argparse
import json
import ssl
import statistics
import time
import urllib.request
from pathlib import Path


def fetch_stats(url: str) -> dict:
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(url, context=context, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"Frigate returned HTTP {response.status}")
        return json.loads(response.read().decode())


def numeric(values: list[object]) -> list[float]:
    result: list[float] = []
    for value in values:
        try:
            result.append(float(value))
        except (TypeError, ValueError):
            pass
    return result


def summary(values: list[object]) -> dict[str, float]:
    numbers = numeric(values)
    if not numbers:
        return {}
    return {
        "mean": statistics.mean(numbers),
        "median": statistics.median(numbers),
        "min": min(numbers),
        "max": max(numbers),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://127.0.0.1:8971/api/stats")
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--detector")
    parser.add_argument("--label", default="frigate")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.seconds <= 0 or args.interval <= 0:
        raise SystemExit("seconds and interval must be greater than zero")

    samples: list[dict] = []
    failures: list[str] = []
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline or not samples:
        try:
            sample = fetch_stats(args.url)
            sample["collected_at"] = time.time()
            samples.append(sample)
        except Exception as error:  # noqa: BLE001
            failures.append(str(error))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(args.interval, remaining))

    if not samples:
        raise SystemExit(f"No Frigate stats collected: {failures[-1] if failures else 'unknown error'}")

    detector_names = sorted({name for sample in samples for name in sample.get("detectors", {})})
    detector_name = args.detector or (detector_names[0] if detector_names else "")
    detector_samples = [sample.get("detectors", {}).get(detector_name, {}) for sample in samples]
    camera_samples = [sample.get("cameras", {}).get("front", {}) for sample in samples]
    system_samples = [sample.get("cpu_usages", {}).get("frigate.full_system", {}) for sample in samples]
    result = {
        "benchmark": f"jarvis-detector-spike-{args.label}",
        "url": args.url,
        "samples": len(samples),
        "failures": failures,
        "service": samples[-1].get("service", {}),
        "detector": {
            "name": detector_name,
            "inference_speed_ms": summary([item.get("inference_speed") for item in detector_samples]),
            "detection_start": summary([item.get("detection_start") for item in detector_samples]),
        },
        "camera": {
            "camera_fps": summary([item.get("camera_fps") for item in camera_samples]),
            "process_fps": summary([item.get("process_fps") for item in camera_samples]),
            "detection_fps": summary([item.get("detection_fps") for item in camera_samples]),
            "detection_enabled": all(item.get("detection_enabled") is True for item in camera_samples),
        },
        "container": {
            "cpu_percent": summary([item.get("cpu") for item in system_samples]),
            "memory_percent": summary([item.get("mem") for item in system_samples]),
        },
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    print(serialized)
    if args.output:
        args.output.write_text(serialized + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
