export const LIVE_VIDEO_CONTENT_TYPE = 'video/mp2t';

export interface LiveVideoFfmpegOptions {
  ffmpegPath?: string;
  transport: 'udp' | 'tcp';
  width?: number;
}

export function liveVideoContentType(): string {
  return LIVE_VIDEO_CONTENT_TYPE;
}

export function liveVideoFfmpegArgs(
  streamUrl: string,
  options: LiveVideoFfmpegOptions,
): string[] {
  if (!streamUrl.trim()) throw new Error('Live video stream URL must not be empty');
  if (options.transport !== 'udp' && options.transport !== 'tcp') {
    throw new Error('Live video transport must be udp or tcp');
  }
  const width = options.width ?? 1280;
  if (!Number.isInteger(width) || width < 320 || width > 1920) {
    throw new Error('Live video width must be an integer between 320 and 1920');
  }
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    options.transport,
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-i',
    streamUrl,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `scale=${width}:-2`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-bf',
    '0',
    '-g',
    '15',
    '-keyint_min',
    '15',
    '-sc_threshold',
    '0',
    '-flush_packets',
    '1',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-mpegts_flags',
    'resend_headers',
    '-f',
    'mpegts',
    'pipe:1',
  ];
}
