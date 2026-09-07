from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel


def transcribe(model: WhisperModel, request: dict[str, Any]) -> dict[str, Any]:
    payload = base64.b64decode(request["audioBase64"], validate=True)
    mime_type = str(request.get("mimeType", "audio/wav"))
    suffix = ".wav" if "wav" in mime_type else ".audio"
    fd, audio_path = tempfile.mkstemp(prefix="jarvis-stt-", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as audio_file:
            audio_file.write(payload)
        segments, info = model.transcribe(
            audio_path,
            language="pt",
            task="transcribe",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
            beam_size=5,
            best_of=5,
            temperature=0.0,
            condition_on_previous_text=False,
        )
        rows = list(segments)
        text = " ".join((row.text or "").strip() for row in rows).strip()
        average_logprob = sum(float(getattr(row, "avg_logprob", -1.0)) for row in rows) / len(rows) if rows else -1.0
        confidence = max(0.0, min(1.0, (average_logprob + 2.0) / 2.0)) if rows else 0.0
        return {
            "type": "result",
            "id": request["id"],
            "ok": True,
            "text": text,
            "language": getattr(info, "language", "pt"),
            "confidence": confidence,
        }
    finally:
        Path(audio_path).unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        raise SystemExit("usage: faster_whisper_worker.py MODEL")
    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
    print(json.dumps({"type": "ready"}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            response = transcribe(model, request)
        except Exception as error:  # noqa: BLE001 - protocol must return the failure
            response = {
                "type": "result",
                "id": request.get("id"),
                "ok": False,
                "error": str(error)[:500] or "faster-whisper worker failed",
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
