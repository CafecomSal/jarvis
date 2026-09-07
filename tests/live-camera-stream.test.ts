import { describe, expect, it } from 'vitest';
import { LIVE_STREAM_BOUNDARY, liveStreamContentType, multipartFrame } from '../src/cameras/live-camera-stream.js';

describe('stream ao vivo de câmera', () => {
  it('monta frames MJPEG sem alterar os bytes da imagem', () => {
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const packet = multipartFrame(frame, 'image/jpeg');

    expect(liveStreamContentType()).toBe(`multipart/x-mixed-replace; boundary=${LIVE_STREAM_BOUNDARY}`);
    expect(packet.toString('latin1')).toContain(`--${LIVE_STREAM_BOUNDARY}\r\n`);
    expect(packet.toString('latin1')).toContain('Content-Type: image/jpeg\r\n');
    expect(packet.toString('latin1')).toContain(`Content-Length: ${frame.length}\r\n\r\n`);
    expect(packet.subarray(packet.length - frame.length - 2, packet.length - 2)).toEqual(frame);
    expect(packet.subarray(packet.length - 2).toString()).toBe('\r\n');
  });
});
