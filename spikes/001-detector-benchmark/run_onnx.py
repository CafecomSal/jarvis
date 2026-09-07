#!/usr/bin/env python3
"""Disposable ONNX/CPU benchmark for one or more JPEG frames."""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


MODEL_DEFAULT = Path(__file__).with_name("models") / "yolo11n.onnx"


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = (len(ordered) - 1) * percentile_value / 100.0
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = rank - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def decode_letterboxed(path: Path, size: int) -> np.ndarray:
    filter_chain = (
        f"scale={size}:{size}:force_original_aspect_ratio=decrease:flags=bilinear,"
        f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2:color=727272"
    )
    completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-vf",
            filter_chain,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    expected_bytes = size * size * 3
    if len(completed.stdout) != expected_bytes:
        raise RuntimeError(f"Unexpected decoded frame size for {path}: {len(completed.stdout)}")
    image = np.frombuffer(completed.stdout, dtype=np.uint8).reshape(size, size, 3)
    return image.transpose(2, 0, 1).astype(np.float32) / 255.0


def iou(left: np.ndarray, right: np.ndarray) -> float:
    x1 = max(float(left[0]), float(right[0]))
    y1 = max(float(left[1]), float(right[1]))
    x2 = min(float(left[2]), float(right[2]))
    y2 = min(float(left[3]), float(right[3]))
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, float(left[2] - left[0])) * max(0.0, float(left[3] - left[1]))
    right_area = max(0.0, float(right[2] - right[0])) * max(0.0, float(right[3] - right[1]))
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def detect_people(output: np.ndarray, threshold: float, nms_threshold: float) -> list[dict[str, float]]:
    predictions = np.asarray(output)
    if predictions.ndim == 3:
        predictions = predictions[0]
    if predictions.shape[0] < predictions.shape[1]:
        predictions = predictions.transpose(1, 0)
    class_scores = predictions[:, 4:]
    class_ids = class_scores.argmax(axis=1)
    scores = class_scores.max(axis=1)
    candidates: list[tuple[float, np.ndarray]] = []
    for row, class_id, score in zip(predictions, class_ids, scores):
        if int(class_id) != 0 or float(score) < threshold:
            continue
        center_x, center_y, width, height = row[:4]
        box = np.array(
            [
                center_x - width / 2,
                center_y - height / 2,
                center_x + width / 2,
                center_y + height / 2,
            ],
            dtype=np.float32,
        )
        candidates.append((float(score), box))
    candidates.sort(key=lambda item: item[0], reverse=True)
    selected: list[dict[str, float]] = []
    for score, box in candidates:
        if any(iou(box, np.array([item["x1"], item["y1"], item["x2"], item["y2"]])) > nms_threshold for item in selected):
            continue
        selected.append(
            {
                "confidence": score,
                "x1": float(box[0]),
                "y1": float(box[1]),
                "x2": float(box[2]),
                "y2": float(box[3]),
            }
        )
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL_DEFAULT)
    parser.add_argument("--image", type=Path, action="append", required=True)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--provider", choices=["CPUExecutionProvider", "CUDAExecutionProvider"], default="CPUExecutionProvider")
    parser.add_argument("--size", type=int, default=640)
    parser.add_argument("--threshold", type=float, default=0.25)
    parser.add_argument("--nms-threshold", type=float, default=0.45)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.iterations < 1 or args.warmup < 0 or args.threads < 1:
        raise SystemExit("iterations and threads must be >= 1; warmup must be >= 0")
    if not args.model.is_file():
        raise SystemExit(f"Model not found: {args.model}")
    for image in args.image:
        if not image.is_file():
            raise SystemExit(f"Image not found: {image}")

    frames = [decode_letterboxed(image, args.size) for image in args.image]
    batch = np.stack(frames, axis=0)[:1]
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = args.threads
    session_options.inter_op_num_threads = 1
    session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    providers = [args.provider]
    if args.provider != "CPUExecutionProvider":
        providers.append("CPUExecutionProvider")
    session = ort.InferenceSession(
        str(args.model),
        sess_options=session_options,
        providers=providers,
    )
    input_name = session.get_inputs()[0].name
    for _ in range(args.warmup):
        session.run(None, {input_name: batch})

    timings_ms: list[float] = []
    frame_results: list[dict[str, object]] = []
    for index in range(args.iterations):
        frame_index = index % len(frames)
        started = time.perf_counter()
        outputs = session.run(None, {input_name: frames[frame_index][None, ...]})
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        people = detect_people(outputs[0], args.threshold, args.nms_threshold)
        timings_ms.append(elapsed_ms)
        frame_results.append(
            {
                "image": str(args.image[frame_index]),
                "person_count": len(people),
                "max_person_confidence": max((item["confidence"] for item in people), default=0.0),
            }
        )

    result = {
        "benchmark": f"jarvis-detector-spike-onnx-{args.provider.removesuffix('ExecutionProvider').lower()}",
        "model": str(args.model),
        "providers": session.get_providers(),
        "requested_provider": args.provider,
        "onnxruntime": ort.__version__,
        "threads": args.threads,
        "input_size": [args.size, args.size],
        "iterations": args.iterations,
        "warmup": args.warmup,
        "threshold": args.threshold,
        "nms_threshold": args.nms_threshold,
        "inference_ms": {
            "mean": statistics.mean(timings_ms),
            "median": statistics.median(timings_ms),
            "p50": percentile(timings_ms, 50),
            "p95": percentile(timings_ms, 95),
            "min": min(timings_ms),
            "max": max(timings_ms),
        },
        "inference_fps": 1000.0 / statistics.mean(timings_ms),
        "frames": frame_results,
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    print(serialized)
    if args.output:
        args.output.write_text(serialized + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
