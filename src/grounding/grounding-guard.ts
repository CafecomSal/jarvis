export interface ToolEvidence {
  name: string;
  result: unknown;
}

const LIVE_EVIDENCE_TOOLS = new Set([
  'get_camera_snapshot',
  'get_sensor_state',
  'get_live_presence',
]);

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isPresenceQuestion(message: string): boolean {
  const normalized = normalize(message);
  return /\btem alguem\b|\bha alguem\b|\bquem esta\b|\balguem esta\b|\bquantas pessoas\b/.test(normalized);
}

function isSuccessfulLiveEvidence(item: ToolEvidence): boolean {
  if (!LIVE_EVIDENCE_TOOLS.has(item.name)) return false;
  if (item.result === null || typeof item.result !== 'object' || Array.isArray(item.result)) return false;
  const result = item.result as Record<string, unknown>;
  if (typeof result.error === 'string') return false;
  return item.name !== 'get_camera_snapshot' || result.imageAttached === true;
}

export class GroundingGuard {
  calibrate(message: string, answer: string, evidence: ToolEvidence[]): string {
    if (!isPresenceQuestion(message)) return answer;

    const hasLiveEvidence = evidence.some(isSuccessfulLiveEvidence);
    if (hasLiveEvidence) return answer;

    return 'Não é possível confirmar a presença em tempo real com as informações disponíveis. O Core consultou apenas o estado e os eventos registrados; é necessária uma leitura atualizada de câmera ou sensor.';
  }
}
