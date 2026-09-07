import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { HomeEvent } from '../events/schema.js';

export interface PersonNotificationSink {
  notify(event: HomeEvent, attachmentPath?: string): Promise<void>;
}

export interface PreparedPersonNotificationAttachment {
  path: string;
  cleanup?: () => Promise<void>;
}

export type PersonNotificationAttachmentPreparer = (
  sourcePath: string,
) => Promise<PreparedPersonNotificationAttachment | undefined>;

export interface PersonNotifier {
  notify(event: HomeEvent): Promise<boolean>;
}

export interface ConfirmedPersonNotifierOptions {
  sink: PersonNotificationSink;
  resolveAttachment?: (event: HomeEvent) => Promise<string | undefined>;
}

function isConfirmedOnnxPersonEvent(event: HomeEvent): boolean {
  return event.type === 'person.detected'
    && event.source.type === 'onnx'
    && event.data.confirmed === true;
}

export class ConfirmedPersonNotifier implements PersonNotifier {
  private readonly notifiedEventIds = new Set<string>();

  constructor(private readonly options: ConfirmedPersonNotifierOptions) {}

  async notify(event: HomeEvent): Promise<boolean> {
    if (!isConfirmedOnnxPersonEvent(event) || this.notifiedEventIds.has(event.id)) {
      return false;
    }
    let attachmentPath: string | undefined;
    if (this.options.resolveAttachment) {
      try {
        attachmentPath = await this.options.resolveAttachment(event);
      } catch {
        attachmentPath = undefined;
      }
    }
    await this.options.sink.notify(event, attachmentPath);
    this.notifiedEventIds.add(event.id);
    return true;
  }
}

function formatPersonNotification(event: HomeEvent, attachmentPath?: string): string {
  const camera = typeof event.data.camera === 'string' ? event.data.camera : event.source.id;
  const confidence = event.confidence === undefined ? 'não informada' : `${Math.round(event.confidence * 100)}%`;
  const model = typeof event.data.model === 'string' ? event.data.model : event.source.id;
  const lines = [
    '🚶 Pessoa detectada',
    `Câmera: ${camera}`,
    `Local: ${event.location ?? 'não informado'}`,
    `Confiança: ${confidence}`,
    `Horário: ${event.timestamp}`,
    `Modelo: ${model}`,
    'Evidência registrada no Jarvis Core.',
  ];
  if (attachmentPath?.trim()) lines.push(`MEDIA:${attachmentPath}`);
  return lines.join('\n');
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Notification screenshot preparation timed out'));
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.once('error', () => {
      finish(() => reject(new Error('Notification screenshot preparation could not start')));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(new Error('Notification screenshot preparation failed'));
      });
    });
  });
}

export interface TelegramNotificationImagePreparationOptions {
  ffmpegPath?: string;
  outputDirectory?: string;
  timeoutMs?: number;
}

export async function prepareTelegramNotificationImage(
  sourcePath: string,
  options: TelegramNotificationImagePreparationOptions = {},
): Promise<PreparedPersonNotificationAttachment> {
  const ffmpegPath = options.ffmpegPath?.trim() || process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const outputDirectory = resolve(
    options.outputDirectory?.trim()
      || process.env.JARVIS_NOTIFICATION_PREVIEW_DIR?.trim()
      || join(tmpdir(), 'jarvis-notification-previews'),
  );
  const outputPath = join(outputDirectory, `person-${randomUUID()}.jpg`);
  await mkdir(outputDirectory, { recursive: true });
  try {
    await runFfmpeg(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '6',
      outputPath,
    ], options.timeoutMs ?? 30_000);
    const metadata = await stat(outputPath);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error('Notification screenshot preparation returned an empty file');
    }
    return {
      path: outputPath,
      cleanup: async () => {
        await rm(outputPath, { force: true });
      },
    };
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

export type TelegramNotificationSend = (target: string, message: string) => Promise<void>;

function sendWithHermes(target: string, message: string): Promise<void> {
  const command = process.env.HERMES_SEND_COMMAND?.trim() || 'hermes';
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['send', '--to', target, message], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.once('error', () => reject(new Error('Telegram notification command could not start')));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Telegram notification failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

export interface TelegramPersonNotificationSinkOptions {
  target: string;
  send?: TelegramNotificationSend;
  prepareAttachment?: PersonNotificationAttachmentPreparer;
}

export class TelegramPersonNotificationSink implements PersonNotificationSink {
  private readonly target: string;
  private readonly send: TelegramNotificationSend;
  private readonly prepareAttachment?: PersonNotificationAttachmentPreparer;

  constructor(options: TelegramPersonNotificationSinkOptions) {
    this.target = options.target.trim();
    this.send = options.send ?? sendWithHermes;
    this.prepareAttachment = options.prepareAttachment;
    if (!this.target) throw new Error('Telegram notification target must not be empty');
  }

  async notify(event: HomeEvent, attachmentPath?: string): Promise<void> {
    let preparedPath = attachmentPath;
    let cleanup: (() => Promise<void>) | undefined;
    if (attachmentPath && this.prepareAttachment) {
      try {
        const prepared = await this.prepareAttachment(attachmentPath);
        preparedPath = prepared?.path;
        cleanup = prepared?.cleanup;
      } catch {
        preparedPath = undefined;
      }
    }
    try {
      await this.send(this.target, formatPersonNotification(event, preparedPath));
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // Cleanup is best effort; it must not turn a delivered alert into a failure.
        }
      }
    }
  }
}

export function createPersonNotifierFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
  send?: TelegramNotificationSend,
  resolveAttachment?: (event: HomeEvent) => Promise<string | undefined>,
  prepareAttachment?: PersonNotificationAttachmentPreparer,
): PersonNotifier | undefined {
  const target = environment.JARVIS_TELEGRAM_NOTIFICATION_TARGET?.trim();
  if (!target) return undefined;
  return new ConfirmedPersonNotifier({
    sink: new TelegramPersonNotificationSink({
      target,
      send,
      prepareAttachment: prepareAttachment ?? ((sourcePath) => prepareTelegramNotificationImage(sourcePath)),
    }),
    resolveAttachment,
  });
}
