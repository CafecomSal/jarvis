# DVR e Google Drive

## Perfis

- `continuous-economic`: 1280x1440, 5 FPS, H.264 com bitrate reduzido, segmento de 60 s.
- `event-high-quality`: 1920x2160, 10 FPS, bitrate maior, segmento de 15 s.
- `manual-export`: duração definida pelo comando.

O comando contínuo é manual:

```bash
JARVIS_RECORDING_PROFILE=continuous-economic npm run record -- --continuous
```

## Arquivamento

```text
segmento local -> RecordingUploadQueue -> Drive upload -> readback -> verified
```

O scheduler de fila exige `JARVIS_RECORDING_BACKUP_ENABLED=true` e autenticação Drive. Retry tem limite e backoff; falha preserva o staging.

## Retenção

- contínuo: 30 dias;
- eventos: 90 dias;
- `protected`: manual;
- remoto: `JARVIS_RECORDING_REMOTE_RETENTION_ENABLED=true`;
- lixeira é o padrão;
- delete permanente exige `JARVIS_DRIVE_PERMANENT_DELETE=true`;
- apagar staging após readback exige `JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY=true`.

O dry-run não escreve nem apaga:

```bash
npm run record:retention
```
