import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collect_rtsp_dataset as collector


class CollectRtspDatasetTests(unittest.TestCase):
    def test_capture_rtsp_frame_uses_udp_and_returns_jpeg(self):
        jpeg = b"\xff\xd8frame\xff\xd9"
        completed = collector.subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=jpeg,
            stderr=b"",
        )

        with patch.object(collector.subprocess, "run", return_value=completed) as run:
            result = collector.capture_rtsp_frame(
                "rtsp://camera.local/stream",
                transport="udp",
                ffmpeg_path="ffmpeg",
                timeout=10,
            )

        self.assertEqual(result, jpeg)
        args, kwargs = run.call_args
        self.assertIn("-rtsp_transport", args[0])
        self.assertEqual(args[0][args[0].index("-rtsp_transport") + 1], "udp")
        self.assertEqual(args[0][-3:], ["-c:v", "mjpeg", "pipe:1"])
        self.assertEqual(kwargs["timeout"], 10)

    def test_manifest_redacts_rtsp_source(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            rows = collector.capture_samples(
                output,
                label="negative",
                count=1,
                interval=0,
                capture=lambda: b"\xff\xd8frame\xff\xd9",
            )
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(len(rows), 1)
        self.assertEqual(manifest[0]["source"], "rtsp")
        self.assertEqual(manifest[0]["source_url"], "[REDACTED_RTSP_URL]")
        self.assertNotIn("rtsp://", json.dumps(manifest))


if __name__ == "__main__":
    unittest.main()
