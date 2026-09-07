export const LIVE_STREAM_BOUNDARY = 'jarvis-live-frame';

export function liveStreamContentType(boundary = LIVE_STREAM_BOUNDARY): string {
  return `multipart/x-mixed-replace; boundary=${boundary}`;
}

export function multipartFrame(frame: Buffer, mimeType = 'image/jpeg', boundary = LIVE_STREAM_BOUNDARY): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Length: ${frame.length}\r\n\r\n`,
    'ascii',
  );
  return Buffer.concat([header, frame, Buffer.from('\r\n', 'ascii')]);
}
