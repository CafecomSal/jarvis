import mpegtsModule from 'mpegts.js';

interface MpegtsPlayer {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  attachMediaElement(mediaElement: HTMLMediaElement): void;
  detachMediaElement(): void;
  load(): void;
  unload(): void;
  play(): Promise<void> | void;
  pause(): void;
  destroy(): void;
}

interface MpegtsApi {
  isSupported(): boolean;
  createPlayer(
    mediaDataSource: { type: string; isLive: boolean; hasAudio: boolean; hasVideo: boolean; url: string },
    config: Record<string, unknown>,
  ): MpegtsPlayer;
  Events: { ERROR: string };
}

const mpegts = mpegtsModule as unknown as MpegtsApi;

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface LiveVideoPlayerHandle {
  destroy(): void;
}

export function attachLiveVideoPlayer(
  video: HTMLVideoElement,
  url: string,
  onError: (message?: string) => void,
): LiveVideoPlayerHandle | null {
  if (!mpegts.isSupported()) return null;
  const player = mpegts.createPlayer(
    {
      type: 'mpegts',
      isLive: true,
      hasAudio: false,
      hasVideo: true,
      url,
    },
    {
      enableWorker: false,
      enableStashBuffer: false,
      isLive: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      liveSync: true,
      liveSyncMaxLatency: 1.2,
      liveSyncTargetLatency: 0.8,
      liveSyncPlaybackRate: 1.2,
      lazyLoad: false,
      deferLoadAfterSourceOpen: false,
    },
  );
  const handleError = (...args: unknown[]): void => {
    const detail = args.map(describeError).filter(Boolean).join(' · ');
    onError(detail || 'mpegts player error');
  };
  player.on(mpegts.Events.ERROR, handleError);
  player.attachMediaElement(video);
  player.load();
  const playback = player.play();
  if (playback instanceof Promise) void playback.catch((error: unknown) => onError(describeError(error) || 'video playback error'));
  return {
    destroy: () => {
      player.off(mpegts.Events.ERROR, handleError);
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    },
  };
}
