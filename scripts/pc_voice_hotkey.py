"""Manual Windows global-hotkey bridge for Jarvis PC voice sessions.

This helper is intentionally not installed as a startup task. Run it manually
when you want a global toggle hotkey. Raw audio is kept in memory only and is
never written to disk.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
import wave
from array import array
from typing import Any


def encode_wav(samples: list[int], sample_rate: int = 16000) -> bytes:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    pcm = array("h", samples)
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return output.getvalue()


def build_audio_payload(audio: bytes, mime_type: str = "audio/wav") -> dict[str, str]:
    if not audio:
        raise ValueError("audio must not be empty")
    if not mime_type.strip():
        raise ValueError("mime_type must not be empty")
    return {
        "mimeType": mime_type.split(";", 1)[0].strip(),
        "audioBase64": base64.b64encode(audio).decode("ascii"),
    }


def decode_response_audio(payload: dict[str, Any]) -> bytes:
    audio = payload.get("audio")
    encoded = audio.get("audioBase64") if isinstance(audio, dict) else None
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("response does not contain audio")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("response audio is not valid base64") from error
    if not decoded:
        raise ValueError("response audio is empty")
    return decoded


def post_audio(audio: bytes, mime_type: str, url: str, timeout: float = 180.0) -> dict[str, Any]:
    payload = json.dumps(build_audio_payload(audio, mime_type)).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("Jarvis audio request failed") from error
    if not isinstance(result, dict):
        raise RuntimeError("Jarvis audio response was invalid")
    return result


def capture_microphone(
    stop_event: threading.Event,
    sample_rate: int,
    max_seconds: float,
    device: int | None = None,
) -> bytes:
    import sounddevice as sd

    frames: list[bytes] = []

    def callback(indata: Any, _frames: int, _time_info: Any, status: Any) -> None:
        if status:
            print(f"[audio] status: {status}")
        frames.append(bytes(indata))
        if len(frames) * 1024 >= sample_rate * max_seconds:
            stop_event.set()

    stream_kwargs: dict[str, Any] = {
        "samplerate": sample_rate,
        "channels": 1,
        "dtype": "int16",
        "callback": callback,
        "blocksize": 1024,
    }
    if device is not None:
        stream_kwargs["device"] = device
    with sd.InputStream(**stream_kwargs):
        deadline = time.monotonic() + max_seconds
        while not stop_event.is_set() and time.monotonic() < deadline:
            time.sleep(0.05)
    if not frames:
        raise RuntimeError("no microphone samples captured")
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"".join(frames))
    return output.getvalue()


def play_wav(audio: bytes) -> None:
    try:
        import winsound
        winsound.PlaySound(audio, winsound.SND_MEMORY)
    except (ImportError, RuntimeError):
        print("[audio] resposta pronta; winsound indisponível")


def run_listener(url: str, hotkey: str, sample_rate: int, max_seconds: float, device: int | None) -> None:
    import keyboard

    state = {"running": False, "stop": None}
    lock = threading.Lock()

    def finish_audio(stop_event: threading.Event) -> None:
        try:
            audio = capture_microphone(stop_event, sample_rate, max_seconds, device)
            print(f"[audio] enviando sessão ({len(audio)} bytes em memória)")
            response = post_audio(audio, "audio/wav", url)
            session = response.get("session", {})
            conversation = response.get("conversation", {})
            print(json.dumps({
                "status": session.get("status"),
                "transcript": session.get("transcript", {}).get("text"),
                "answer": conversation.get("answer"),
                "ttsProvider": response.get("audio", {}).get("provider"),
            }, ensure_ascii=False))
            play_wav(decode_response_audio(response))
        except Exception as error:  # noqa: BLE001 - helper must return to idle
            print(f"[audio] sessão falhou: {error}")
        finally:
            with lock:
                state["running"] = False
                state["stop"] = None
            print("[audio] pronto")

    def toggle() -> None:
        with lock:
            if state["running"]:
                stop_event = state["stop"]
                if isinstance(stop_event, threading.Event):
                    stop_event.set()
                print("[audio] encerrando captura")
                return
            stop_event = threading.Event()
            state["running"] = True
            state["stop"] = stop_event
        print(f"[audio] ouvindo; pressione {hotkey} novamente para enviar")
        threading.Thread(target=finish_audio, args=(stop_event,), daemon=True).start()

    keyboard.add_hotkey(hotkey, toggle)
    print(f"[audio] helper ativo; hotkey={hotkey}; Ctrl+C para sair")
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        with lock:
            stop_event = state["stop"]
            if isinstance(stop_event, threading.Event):
                stop_event.set()
        print("[audio] helper encerrado")


def main() -> None:
    parser = argparse.ArgumentParser(description="Jarvis PC global voice hotkey")
    parser.add_argument("--url", default=os.getenv("JARVIS_AUDIO_URL", "http://127.0.0.1:3000/audio/pc"))
    parser.add_argument("--hotkey", default=os.getenv("JARVIS_VOICE_HOTKEY", "ctrl+alt+j"))
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--max-seconds", type=float, default=12.0)
    parser.add_argument("--device", type=int, default=None)
    args = parser.parse_args()
    if args.sample_rate <= 0 or args.max_seconds <= 0:
        raise SystemExit("sample rate and max seconds must be positive")
    run_listener(args.url, args.hotkey, args.sample_rate, args.max_seconds, args.device)


if __name__ == "__main__":
    main()
