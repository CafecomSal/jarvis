export type PageId = 'overview' | 'cameras' | 'timeline' | 'events' | 'tags' | 'ocr' | 'chat' | 'audio' | 'drive' | 'system' | 'actions' | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  icon: string;
  description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: 'Visão geral', icon: '⌂', description: 'Estado operacional do Jarvis' },
  { id: 'cameras', label: 'Câmeras', icon: '◉', description: 'Prévia ao vivo e saúde RTSP' },
  { id: 'timeline', label: 'Timeline / DVR', icon: '▤', description: 'Gravações, eventos e clips' },
  { id: 'events', label: 'Eventos', icon: '✦', description: 'Detecções e importância' },
  { id: 'tags', label: 'Tags', icon: '#', description: 'Objetos, atributos e relações' },
  { id: 'ocr', label: 'OCR', icon: 'Aa', description: 'Texto observado nas evidências' },
  { id: 'chat', label: 'Chat / Gemma', icon: '✺', description: 'Conversa fundamentada' },
  { id: 'audio', label: 'Áudio', icon: '◖', description: 'Push-to-talk e destinos de voz' },
  { id: 'drive', label: 'Drive', icon: '↥', description: 'Arquivo e retenção remota' },
  { id: 'system', label: 'Sistema', icon: '◌', description: 'Modelos, GPU, processos e health' },
  { id: 'actions', label: 'Ações', icon: '⚡', description: 'Propostas e confirmações futuras' },
  { id: 'settings', label: 'Configurações', icon: '⚙', description: 'Políticas e limites' },
];

export function pageFromHash(hash: string): PageId {
  const candidate = hash.replace(/^#/, '') as PageId;
  return NAV_ITEMS.some((item) => item.id === candidate) ? candidate : 'overview';
}

export interface CameraFramePresentation {
  objectFit: 'contain';
  aspectRatio?: string;
}

export function cameraFramePresentation(width?: number, height?: number): CameraFramePresentation {
  const hasValidDimensions = typeof width === 'number' && Number.isFinite(width) && width > 0
    && typeof height === 'number' && Number.isFinite(height) && height > 0;
  return {
    objectFit: 'contain',
    ...(hasValidDimensions ? { aspectRatio: `${width} / ${height}` } : {}),
  };
}

export function cameraLiveState(status: string, previewFailed: boolean): 'loading' | 'ready' | 'unavailable' {
  if (status === 'consultando') return 'loading';
  if (status === 'ok' && !previewFailed) return 'ready';
  return 'unavailable';
}

export function pageTitle(id: PageId): string {
  return NAV_ITEMS.find((item) => item.id === id)?.label ?? 'Jarvis';
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'data desconhecida';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}
