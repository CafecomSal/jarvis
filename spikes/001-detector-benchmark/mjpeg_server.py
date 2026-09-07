#!/usr/bin/env python3
"""Disposable MJPEG loop used as a deterministic Frigate input."""

from __future__ import annotations

import argparse
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class MjpegHandler(BaseHTTPRequestHandler):
    frames: list[bytes] = []
    fps: float = 2.0

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/stream.mjpg":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Pragma", "no-cache")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        delay = 1.0 / self.fps
        index = 0
        try:
            while True:
                frame = self.frames[index % len(self.frames)]
                index += 1
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode())
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                time.sleep(delay)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, action="append", required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fps", type=float, default=2.0)
    args = parser.parse_args()
    if args.fps <= 0:
        raise SystemExit("fps must be greater than zero")
    frames = [image.read_bytes() for image in args.image]
    if not frames:
        raise SystemExit("at least one image is required")
    MjpegHandler.frames = frames
    MjpegHandler.fps = args.fps
    server = ThreadingHTTPServer((args.host, args.port), MjpegHandler)
    print(f"MJPEG stream listening on http://{args.host}:{args.port}/stream.mjpg", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
