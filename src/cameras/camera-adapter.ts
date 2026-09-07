export type CameraHealthStatus =
  | 'ok'
  | 'agent_dvr_unavailable'
  | 'rtsp_unavailable'
  | 'camera_not_found'
  | 'unexpected_response'
  | 'timeout';

export interface CameraHealth {
  camera: string;
  oid?: number;
  sourceType?: string;
  sourceId?: string;
  status: CameraHealthStatus;
  checkedAt: string;
  detail?: string;
}

export interface CameraSnapshot {
  camera: string;
  oid?: number;
  sourceType?: string;
  sourceId?: string;
  capturedAt: string;
  mimeType: string;
  bytes: number;
  base64: string;
  imageRef?: string;
}

export interface CameraAdapter {
  snapshot(camera: string): Promise<CameraSnapshot>;
  health?(camera: string): Promise<CameraHealth>;
}
