#!/usr/bin/env python3
"""Sequential local Ollama benchmark: one model resident at a time."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:11434"
MODELS = ["gemma-hermes:latest", "gemma4:e2b-it-q4_K_M"]
IMAGE_PATH = Path(os.environ.get(
    "GEMMA_BENCH_IMAGE",
    "data/snapshots/front/2026-09-02T175619125Z-1c47ffa2-b2b2-4856-8b08-767b4b3ce864.jpg",
))
OUTPUT_PATH = Path(os.environ.get(
    "GEMMA_BENCH_OUTPUT",
    "spikes/004-gemma-e2b-benchmark/results/gemma-e2b-vs-e4b.json",
))
THINK_SETTING = os.environ.get("GEMMA_BENCH_THINK", "default").lower()


def api(path: str, payload: dict | None = None, timeout: int = 180) -> dict:
    url = f"{BASE_URL}{path}"
    if payload is None:
        request = urllib.request.Request(url, method="GET")
    else:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def gpu_snapshot() -> dict:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=memory.used,memory.free,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    values = [float(part.strip()) for part in result.stdout.strip().split(",")]
    return {"memory_used_mib": values[0], "memory_free_mib": values[1], "gpu_util_percent": values[2]}


def stop_model(model: str) -> None:
    subprocess.run(["ollama", "stop", model], capture_output=True, text=True, timeout=60)


def loaded_models() -> list[dict]:
    try:
        return api("/api/ps", timeout=20).get("models", [])
    except Exception:
        return []


def wait_until_empty(timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not loaded_models():
            return
        time.sleep(0.5)
    raise RuntimeError("Ollama did not unload the previous model")


def chat(model: str, messages: list[dict], tools: list[dict] | None = None) -> dict:
    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": "10m",
        "options": {"num_ctx": 8192, "temperature": 0.2},
    }
    if THINK_SETTING in {"true", "false"}:
        payload["think"] = THINK_SETTING == "true"
    if tools is not None:
        payload["tools"] = tools
    started = time.perf_counter()
    response = api("/api/chat", payload)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {
        "wall_ms": round(elapsed_ms, 2),
        "total_ms": round(float(response.get("total_duration", 0)) / 1_000_000, 2),
        "load_ms": round(float(response.get("load_duration", 0)) / 1_000_000, 2),
        "prompt_eval_ms": round(float(response.get("prompt_eval_duration", 0)) / 1_000_000, 2),
        "eval_ms": round(float(response.get("eval_duration", 0)) / 1_000_000, 2),
        "prompt_tokens": response.get("prompt_eval_count"),
        "eval_tokens": response.get("eval_count"),
        "message": response.get("message", {}),
    }


def text_preview(message: dict) -> str:
    return str(message.get("content", "")).strip()[:500]


def run_model(model: str, image_base64: str) -> dict:
    stop_model(model)
    wait_until_empty()
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_home_state",
                "description": "Consulta o estado atual conhecido da residência.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        }
    ]
    before = gpu_snapshot()
    text = chat(model, [{"role": "user", "content": "Responda somente OK."}])
    after_load = gpu_snapshot()
    tool = chat(
        model,
        [{"role": "user", "content": "Use get_home_state e não invente dados."}],
        tools,
    )
    vision = chat(
        model,
        [{
            "role": "user",
            "content": "Descreva objetivamente o que aparece nesta imagem em uma frase.",
            "images": [image_base64],
        }],
    )
    loaded_after = loaded_models()
    result = {
        "model": model,
        "gpu_before": before,
        "gpu_after_load": after_load,
        "loaded_after": loaded_after,
        "text": {key: value for key, value in text.items() if key != "message"},
        "text_preview": text_preview(text["message"]),
        "tool": {
            key: value for key, value in tool.items() if key != "message"
        },
        "tool_preview": text_preview(tool["message"]),
        "tool_call_count": len(tool["message"].get("tool_calls", []) or []),
        "vision": {key: value for key, value in vision.items() if key != "message"},
        "vision_preview": text_preview(vision["message"]),
    }
    stop_model(model)
    wait_until_empty()
    result["gpu_after_stop"] = gpu_snapshot()
    return result


def main() -> None:
    if not IMAGE_PATH.is_file():
        raise SystemExit(f"Image not found: {IMAGE_PATH}")
    image_base64 = base64.b64encode(IMAGE_PATH.read_bytes()).decode("ascii")
    results = []
    for model in MODELS:
        try:
            results.append(run_model(model, image_base64))
        except Exception as error:
            stop_model(model)
            wait_until_empty()
            results.append({"model": model, "error": str(error), "gpu_after_error": gpu_snapshot()})
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({
        "think_setting": THINK_SETTING,
        "image": str(IMAGE_PATH),
        "models": results,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(OUTPUT_PATH),
        "models": [
            {
                "model": item["model"],
                "error": item.get("error"),
                "gpu_after_load": item.get("gpu_after_load"),
                "tool_call_count": item.get("tool_call_count"),
                "text_preview": item.get("text_preview"),
                "vision_preview": item.get("vision_preview"),
            }
            for item in results
        ],
        "loaded_at_end": loaded_models(),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
