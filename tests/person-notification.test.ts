import { describe, expect, it } from 'vitest';
import {
  ConfirmedPersonNotifier,
  TelegramPersonNotificationSink,
  createPersonNotifierFromEnvironment,
  type PersonNotificationSink,
} from '../src/notifications/person-notification.js';
import type { HomeEvent } from '../src/events/schema.js';

const confirmedEvent: HomeEvent = {
  id: 'evt-person-confirmed-001',
  type: 'person.detected',
  timestamp: '2026-09-01T22:00:00Z',
  source: { type: 'onnx', id: 'yolo11n.onnx' },
  location: 'frente',
  subject: { type: 'person', id: 'unknown' },
  confidence: 0.87,
  data: {
    camera: 'front',
    confirmed: true,
    evidenceEventId: 'evt-snapshot-001',
  },
};

describe('notificações de presença confirmada', () => {
  it('notifica somente person.detected confirmado e deduplica pelo ID', async () => {
    const notified: string[] = [];
    const sink: PersonNotificationSink = {
      notify: async (event) => {
        notified.push(event.id);
      },
    };
    const notifier = new ConfirmedPersonNotifier({ sink });

    await expect(notifier.notify({
      ...confirmedEvent,
      id: 'evt-unconfirmed',
      data: { camera: 'front', confirmed: false },
    })).resolves.toBe(false);
    await expect(notifier.notify({
      ...confirmedEvent,
      id: 'evt-other-source',
      source: { type: 'camera', id: 'front' },
    })).resolves.toBe(false);
    await expect(notifier.notify(confirmedEvent)).resolves.toBe(true);
    await expect(notifier.notify(confirmedEvent)).resolves.toBe(false);

    expect(notified).toEqual(['evt-person-confirmed-001']);
  });

  it('permite tentar novamente quando o sink falha', async () => {
    let attempts = 0;
    const notifier = new ConfirmedPersonNotifier({
      sink: {
        notify: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('telegram indisponível');
        },
      },
    });

    await expect(notifier.notify(confirmedEvent)).rejects.toThrow('telegram indisponível');
    await expect(notifier.notify(confirmedEvent)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it('formata o alerta Telegram sem identidade, base64 ou URL RTSP', async () => {
    const sent: Array<{ target: string; message: string }> = [];
    const sink = new TelegramPersonNotificationSink({
      target: 'telegram:Davi',
      send: async (target, message) => {
        sent.push({ target, message });
      },
    });

    await sink.notify(confirmedEvent);

    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('telegram:Davi');
    expect(sent[0].message).toContain('Pessoa detectada');
    expect(sent[0].message).toContain('front');
    expect(sent[0].message).toContain('87%');
    expect(sent[0].message).not.toContain('unknown');
    expect(sent[0].message).not.toContain('base64');
    expect(sent[0].message).not.toContain('rtsp://');
  });

  it('só cria o notifier Telegram quando existe target explícito', async () => {
    expect(createPersonNotifierFromEnvironment({})).toBeUndefined();

    const sent: string[] = [];
    const notifier = createPersonNotifierFromEnvironment(
      { JARVIS_TELEGRAM_NOTIFICATION_TARGET: 'telegram:Davi' },
      async (_target, message) => {
        sent.push(message);
      },
    );

    expect(notifier).toBeDefined();
    await notifier?.notify(confirmedEvent);
    expect(sent).toHaveLength(1);
  });

  it('anexa o snapshot resolvido como mídia no alerta Telegram', async () => {
    const sent: Array<{ target: string; message: string }> = [];
    const notifier = new ConfirmedPersonNotifier({
      resolveAttachment: async () => 'C:\\Users\\davi\\jarvis\\data\\snapshots\\front\\detected.jpg',
      sink: new TelegramPersonNotificationSink({
        target: 'telegram:Davi',
        send: async (target, message) => {
          sent.push({ target, message });
        },
      }),
    });

    await notifier.notify(confirmedEvent);

    expect(sent[0].message).toContain('MEDIA:C:\\Users\\davi\\jarvis\\data\\snapshots\\front\\detected.jpg');
  });

  it('mantém o alerta textual quando o snapshot não está disponível', async () => {
    const sent: string[] = [];
    const notifier = new ConfirmedPersonNotifier({
      resolveAttachment: async () => {
        throw new Error('snapshot ausente');
      },
      sink: {
        notify: async (_event, attachmentPath) => {
          sent.push(attachmentPath ?? '');
        },
      },
    });

    await expect(notifier.notify(confirmedEvent)).resolves.toBe(true);
    expect(sent).toEqual(['']);
  });

  it('envia a prévia preparada e limpa o arquivo temporário depois do envio', async () => {
    const sent: string[] = [];
    let cleaned = false;
    const sink = new TelegramPersonNotificationSink({
      target: 'telegram:Davi',
      prepareAttachment: async (sourcePath) => ({
        path: `${sourcePath}.preview.jpg`,
        cleanup: async () => {
          cleaned = true;
        },
      }),
      send: async (_target, message) => {
        sent.push(message);
      },
    });

    await sink.notify(confirmedEvent, 'C:\\snapshot-original.jpg');

    expect(sent[0]).toContain('MEDIA:C:\\snapshot-original.jpg.preview.jpg');
    expect(cleaned).toBe(true);
  });
});
