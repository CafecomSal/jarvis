# JARVIS — Handoff completo para o Codex

> Documento de transferência operacional e técnica. Leia este arquivo inteiro antes de editar o projeto.
>
> Gerado em: 2026-09-06T23:50:00-03:00
> Workspace: `C:\Users\davi\jarvis`  
> Plataforma: Windows 11 + Git Bash/MSYS  
> Status do documento: baseado no código atual, nos testes executados e nos probes reais descritos abaixo.

---

> Atualização da execução durável em 2026-09-06: o supervisor Windows foi implementado, exercitado e endurecido contra PID reutilizado, corrida de parada, processos externos e falhas de readiness. A tarefa Jarvis Core foi instalada no Task Scheduler e lida de volta com ação, usuário, trigger, diretório e políticas correspondentes. O último smoke encerrou somente Core/Ollama próprios; PostgreSQL externo foi preservado. O estado final desta sessão é deliberadamente parado. Foi criado o backup local CODEX_HANDOFF.md.bak-2026-09-06-durable-ops antes desta atualização.
> Atualização final desta execução: após o reinício autorizado do Docker, o engine 29.0.1 respondeu, o PostgreSQL foi iniciado apenas para a fixture sintética e depois parado. Nenhum volume ou dado real foi removido; Core, Ollama e portas do Jarvis ficaram parados.

## 0. Instrução para o próximo agente

Você é o agente que assumirá o projeto Jarvis. Antes de fazer qualquer mudança:

1. Leia este documento completo.
2. Leia `README.md`, `JARVIS_AI_MAP.md`, `docs/audio-architecture.md` e o plano em `.hermes/plans/2026-09-05_215145-stt-groq-dashboard-sessoes.md`.
3. Trate o código atual como fonte de verdade; não confie em resumos antigos se divergirem dele.
4. Faça primeiro uma inspeção read-only do estado, processos, portas e `.env`.
5. Não imprima valores de `.env`, tokens, URLs RTSP autenticadas, senhas, conteúdo de conversas ou áudio.
6. Não ative Groq, autostart de detector, retenção destrutiva, Drive delete, ações físicas ou qualquer automação nova sem decisão explícita.
7. Use TDD para alterações: teste RED, implementação mínima, GREEN, suíte completa.
8. Preserve a regra de que no máximo um modelo neural fica na GPU.
9. Após qualquer escrita externa, faça readback do estado afetado.
10. O diretório agora é um repositório Git em `main`, com `origin/main` no GitHub. Preserve o backup local antes de alterações arriscadas e nunca faça `force push` sem autorização explícita.

O objetivo desta transferência é permitir que o Codex continue o trabalho sem precisar reconstruir decisões, arquitetura, pendências ou comandos a partir do histórico da conversa.

---

## 1. Resumo executivo

O Jarvis é um Core residencial local-first em Node.js + TypeScript + ESM. Ele combina:

- Ollama/Gemma local para conversa, tool calling e VLM sob demanda;
- PostgreSQL/pgvector para eventos, auditoria, gravações e settings persistentes;
- RTSP/FFmpeg para câmera, snapshots, vídeo contínuo e DVR;
- YOLO11n via ONNX Runtime CPU para detecção de pessoas/objetos;
- RapidOCR/ONNX sob demanda;
- World State, memória episódica/semântica, Grounding Guard e Policy Engine determinísticos;
- dashboard React/Vite servido pelo próprio Core;
- áudio PC push-to-talk;
- Faster-Whisper local em worker CPU residente;
- Groq Whisper como provider cloud implementado, mas opt-in;
- Piper `pt_BR-jeff-medium` para TTS local;
- adapter Home Assistant para Alexa;
- retenções separadas para snapshots, DVR/Drive e sessões de áudio.

A arquitetura separa percepção neural, interpretação e controle. O Gemma propõe texto/tool calls; o Core valida, executa somente tools permitidas, persiste e audita. Nenhuma tool de ação física está habilitada na V0.1.

### Estado atual de produto

- Conversa local: implementada.
- VLM local via Gemma: implementado sob demanda.
- Câmera `front`: RTSP/FFmpeg, snapshots e vídeo H.264/MPEG-TS implementados.
- DVR: gravação manual/contínua explícita, catálogo e retenção segura implementados.
- Detecção ONNX: implementada em processo separado, `dry-run`/não iniciado automaticamente.
- OCR: RapidOCR/ONNX sob demanda.
- Dashboard: overview, câmeras, timeline, eventos, tags, OCR, chat, áudio, Drive, sistema, ações e configurações.
- STT local: implementado e exercitado.
- STT Groq: provider/router/quota/fallback/dashboard implementados; comparação live ainda não concluída.
- TTS Piper: preservado e exercitado com executável real.
- Gerenciamento de sessões de áudio: preview, confirmação, redaction e tombstone implementados.
- Operação durável no Windows: supervisor com health check, backoff, identidade de PID, parada coordenada e Task Scheduler no login implementados.
- Ações físicas: bloqueadas.
- Reconhecimento facial/identidade/ReID: fora da V0.1.

---

## 2. Estado real no momento deste handoff

A última auditoria de máquina encontrou:

| Componente | Estado observado | Detalhe |
|---|---|---|
| Projeto | presente | `C:\Users\davi\jarvis` |
| Git | presente | branch `main`, `origin/main` conferido no commit `712725904a14be6a354a074d16d09ab8867d0b44`; working tree estava limpo antes desta rodada |
| PostgreSQL | parado ao finalizar esta sessão | último smoke reutilizou o container `jarvis-postgres` healthy em `127.0.0.1:5434`; nenhum volume ou dado foi removido |
| Docker Desktop/engine | responsivo, sem containers Jarvis em execução | `docker ps` vazio; pipes `docker_engine` e `dockerDesktopLinuxEngine` presentes; nenhum volume foi alterado |
| Core | parado no estado final | porta `127.0.0.1:3000` fechada; o supervisor inicia o Core compilado quando executado |
| Ollama | parado no estado final | porta `127.0.0.1:11434` fechada; o supervisor inicia `ollama serve` quando necessário |
| Task Scheduler | instalado e conferido | tarefa `Jarvis Core`, trigger `AtLogOn` com atraso de 30 s, usuário atual, `InteractiveToken`/menor privilégio, instância única e restart limitado |
| Tailscale Serve | configurado na última leitura | faz proxy para `http://127.0.0.1:3000`; não foi reconfigurado pelo supervisor |
| Porta 3001 | fechada | instância auxiliar de teste foi encerrada |
| Piper ONNX | presente | `models/tts/piper/pt_BR-jeff-medium.onnx` |
| YOLO11n ONNX | presente | `spikes/001-detector-benchmark/models/yolo11n.onnx` |
| OCR venv | presente | `tools/ocr/.venv` |
| Snapshots | diretório presente | `data/snapshots` |
| Gravações | diretório presente | `data/recordings` |

### Ferramentas detectadas

- Node `v22.14.0`
- npm `11.12.1`
- Python `3.11.9` pelo comando `python`
- `python3` não deve ser presumido neste host
- Docker `29.0.1`
- Ollama client `0.33.2`
- Tailscale `1.102.2`

### `.env`: presença, nunca valores

O arquivo `.env` existe. Na auditoria, os seguintes slots estavam não vazios:

- `DATABASE_URL` — presente; conexão observada para banco `jarvis` em `127.0.0.1:5434`;
- `JARVIS_CAMERA_FRONT_RTSP_URL` — presente; valor é secreto e não deve ser impresso;
- `JARVIS_TELEGRAM_NOTIFICATION_TARGET` — presente; valor não deve ser impresso;
- `GROQ_API_KEY` — slot atualmente não vazio, mas a chave não foi validada em chamada live após essa mudança e seu valor nunca deve ser lido/imprimido;
- `POSTGRES_PORT` — `5434`;
- configurações seguras de STT estão em `route=local`, `medium`, `pt-BR`, fallback `none`, timeout `12000`, Groq turbo como modelo candidato;
- `JARVIS_AUDIO_ENABLED` está ausente no `.env` atual. O default do runtime é `false`; os smoke tests usaram override de processo `JARVIS_AUDIO_ENABLED=true`.

Não assumir que a presença de `GROQ_API_KEY` significa que ela é válida, tem quota ou está autorizada. O primeiro uso cloud deve ser uma decisão explícita, com fixture não sensível e medição de custo/latência.

### Estado histórico de processo

Durante a validação, o Core foi iniciado com:

```bash
JARVIS_AUDIO_ENABLED=true JARVIS_TAILSCALE_SERVE_ENABLED=true npm run dev
```

O Ollama foi iniciado com:

```bash
ollama serve
```

Esses processos foram acompanhados pelo ambiente de execução e posteriormente apareceram como encerrados. Não confundir notificações antigas de `Jarvis Core ouvindo`/`Listening` com processos atualmente ativos.

---

## 3. Como retomar o ambiente

### 3.1 Checagem inicial sem iniciar nada

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
tailscale serve status
python -c "import socket; print({p:(lambda s: (s.connect_ex(('127.0.0.1',p))==0))(socket.socket()) for p in [3000,5434,11434]})"
```

Interpretação:

- `5434` deve estar aberta e `jarvis-postgres` healthy;
- `11434` precisa estar aberta para conversa/Gemma;
- `3000` precisa estar aberta para Core/dashboard;
- Tailscale deve continuar como `tailnet only`, proxyando loopback;
- não iniciar uma segunda instância se a porta já estiver ocupada.

### 3.2 PostgreSQL

Se Docker estiver ativo:

```bash
docker compose up -d postgres
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Compose atual: `docker-compose.yml`.

- imagem: `pgvector/pgvector:pg16`;
- container: `jarvis-postgres`;
- porta externa: `127.0.0.1:5434` por default;
- volume: `jarvis-postgres-data`;
- migrations montadas read-only em `/docker-entrypoint-initdb.d`;
- health check por `pg_isready`.

Se Docker Desktop estiver desligado no Windows, iniciar Docker Desktop antes do Core. O Core não faz fallback silencioso para memória quando `DATABASE_URL` está configurada; os stores persistentes são inicializados no boot.

### 3.3 Ollama

Se `11434` estiver fechada e não houver processo Ollama:

```bash
ollama serve
```

Em outra shell:

```bash
curl http://127.0.0.1:11434/api/tags
ollama ps
```

Modelo padrão:

```text
gemma-hermes:latest
```

Ollama usa a RTX 4060 quando carrega o Gemma. O detector ONNX e o áudio local não devem disputar a GPU.

### 3.4 Core em desenvolvimento

Com Postgres e Ollama prontos:

```bash
JARVIS_AUDIO_ENABLED=true JARVIS_TAILSCALE_SERVE_ENABLED=true npm run dev
```

Isso carrega `.env` e executa `src/server.ts` via `tsx`.

Para Core sem Postgres, somente para testes rápidos e deliberados:

```bash
npm run dev:memory
```

Não usar o modo memória como produção: perde persistência de eventos/auditoria/sessões.

### 3.5 Core compilado

```bash
npm run build
npm start
```

`npm start` executa `dist/src/server.js` com `.env`. O resolvedor `src/infrastructure/postgres-migration.ts` procura migrations tanto no layout de `src` quanto no projeto raiz quando o processo está em `dist`.

### 3.6 Dashboard via Tailscale

O Core deve continuar em loopback. A exposição esperada é:

```bash
tailscale serve --bg 3000
tailscale serve status
```

URL conhecida:

```text
https://pc.tail14bdd9.ts.net/ui/
```

Não usar `tailscale funnel`. Não abrir `3000` diretamente na LAN/WAN. `JARVIS_TAILSCALE_SERVE_ENABLED=true` é apenas indicador de health; o estado real vem de `tailscale serve status`.

---

## 4. Comandos npm disponíveis

Fonte: `package.json`.

```text
npm run build
npm run build:core
npm run build:web
npm run dev
npm run dev:web
npm run audio:hotkey
npm run dev:memory
npm run detector
npm run detector:objects
npm run ocr
npm run record
npm run record:archive
npm run record:retention
npm run index:recording
npm run detector:supervised
npm run detector:status
npm start
npm test
npm run benchmark:stt
```

Detalhes:

- `build`: TypeScript + Vite;
- `build:core`: `tsc -p tsconfig.json`, incluindo `src`, `tests` e `web` tipados;
- `build:web`: Vite, raiz `web`, saída `dist/web`;
- `dev`: Core source com `.env`;
- `dev:web`: Vite em `5173`, proxy para Core `3000`;
- `audio:hotkey`: helper Python manual `Ctrl+Alt+J` por default;
- `detector`: pessoa ONNX, dry-run por default;
- `detector:objects`: classes COCO selecionadas;
- `ocr`: RapidOCR sob demanda;
- `record`: segmento ou contínuo manual;
- `record:archive`: arquivamento Drive por ID explícito;
- `record:retention`: dry-run/retention CLI;
- `index:recording`: indexação histórica com OCR opcional;
- `detector:supervised`: supervisor manual, dry-run por default;
- `detector:status`: status sem iniciar detector;
- `benchmark:stt`: compara local e, se chave estiver disponível, Groq turbo/large.

---

## 5. Arquitetura de execução

```text
Browser / hotkey
  ├─ POST /conversation
  │    └─ ConversationOrchestrator
  │         ├─ OllamaGateway -> POST /api/chat -> gemma-hermes:latest
  │         ├─ ToolRegistry -> PolicyEngine -> stores/câmera/memória
  │         └─ GroundingGuard -> resposta calibrada
  │
  ├─ POST /audio/pc
  │    └─ AudioPipeline
  │         ├─ AudioRuntime
  │         │    └─ SttRouter
  │         │         ├─ FasterWhisperSttProvider -> worker Python CPU
  │         │         └─ GroqSttProvider -> API cloud opt-in
  │         ├─ ConversationOrchestrator
  │         └─ PiperTtsProvider -> WAV CPU -> browser speaker
  │
  ├─ GET /cameras/front/live-video
  │    └─ FFmpeg por conexão -> H.264/MPEG-TS -> mpegts.js/MSE
  │
  └─ GET /cameras/front/preview
       └─ RTSP -> FFmpeg -> JPEG pontual

RTSP front
  ├─ snapshots -> LocalSnapshotStore -> events/audit/Drive retention
  ├─ detector ONNX separado -> POST /events somente com --publish
  ├─ OCR RapidOCR separado/sob demanda
  └─ DVR FFmpeg -> recording_segments -> Drive/readback/retention

PostgreSQL
  ├─ events
  ├─ audit_log
  ├─ recording_segments
  ├─ audio_sessions
  ├─ jarvis_runtime_settings
  └─ stt_usage_records
```

### Divisão entre neural e determinístico

Neural:

- Gemma local: conversa, tool calling e VLM sob demanda;
- YOLO11n: detecção de pessoas/objetos em CPU;
- RapidOCR: OCR sob demanda em CPU;
- Faster-Whisper: STT local em CPU;
- Groq Whisper: STT remoto somente após opt-in;
- Piper: TTS local em CPU.

Determinístico:

- `ConversationOrchestrator` limita a três rodadas de tools;
- `ToolRegistry` valida argumentos e audita;
- `PolicyEngine` bloqueia risco `critical`;
- `GroundingGuard` exige evidência live para presença;
- `WorldStateProjection` ignora eventos atrasados por entidade;
- confirmação temporal do detector: duas observações em até cinco segundos;
- quota local, retenção, redaction, tombstone e readback;
- fila Drive, checksum e status `verified`.

---

## 6. Mapa do código

### Bootstrap e HTTP

- `src/server.ts` — composição de produção, stores, providers, schedulers, shutdown e listen.
- `src/app.ts` — Fastify, schemas HTTP, rotas, composição de orchestrator/pipeline.
- `src/orchestrator.ts` — prompt de sistema PT-BR, no máximo três rodadas, tools, auditoria, visão e Grounding Guard.
- `src/llm/model-gateway.ts` — contrato do gateway/model messages/tool calls.
- `src/llm/ollama-gateway.ts` — adapter HTTP para Ollama.

### Política, ferramentas e estado

- `src/tools/tool-registry.ts` — registro/execução/auditoria de tools.
- `src/policies/policy-engine.ts` — riscos `read`, `low`, `medium`, `critical`; critical bloqueado.
- `src/grounding/grounding-guard.ts` — calibração de respostas sobre presença.
- `src/state/world-state.ts` — pessoas, objetos, portas, timestamps e estado atual.
- `src/events/schema.ts` — eventos aceitos.
- `src/events/in-memory-event-store.ts` — store de memória.
- `src/events/postgres-event-store.ts` — store persistente.
- `src/events/event-query.ts` — filtros episódicos.
- `src/audit/audit-store.ts` — contrato de auditoria.
- `src/audit/in-memory-audit-store.ts` — auditoria de memória.
- `src/audit/postgres-audit-store.ts` — auditoria PostgreSQL.
- `src/audit/audit-utils.ts` — append e sanitização.
- `src/audit/schema.ts` — schema de auditoria.
- `src/memory/memory-service.ts` — memória episódica.
- `src/memory/semantic-memory.ts` — topologia/conhecimento semântico explícito.

### Áudio

- `src/audio/stt-provider.ts` — contrato STT e `SttRequestContext`.
- `src/audio/stt-config.ts` — schemas/config de rota, modelos, idioma, fallback e timeout.
- `src/audio/providers/faster-whisper-stt.ts` — provider local + worker residente.
- `src/audio/providers/groq-stt.ts` — multipart para endpoint Groq, `verbose_json`, erros e rate limits.
- `src/audio/stt-router.ts` — `local`/`groq`/`auto`, fallback e marcação de localização.
- `src/audio/audio-runtime.ts` — providers mutáveis, fila exclusiva, troca serializada e rollback.
- `src/audio/stt-usage-store.ts` — quota em memória/Postgres, custo diário/mensal e idempotência.
- `src/audio/audio-duration-probe.ts` — duração para quota via ffprobe.
- `src/audio/audio-pipeline.ts` — STT → conversa → TTS, sessão e latências.
- `src/audio/audio-types.ts` — schemas de sessão/transcript.
- `src/audio/audio-session-store.ts` — sessão em memória/Postgres.
- `src/audio/audio-session-retention.ts` — preview, confirmação, redaction e tombstone.
- `src/audio/audio-session-retention-scheduler.ts` — auto-retention opt-in.
- `src/audio/tts-provider.ts` — contrato TTS.
- `src/audio/tts-router.ts` — roteamento TTS.
- `src/audio/quota-tts-provider.ts` — quota/cache TTS.
- `src/audio/providers/piper-tts.ts` — processo Piper e WAV.
- `src/audio/providers/azure-tts.ts` — Azure opcional, não promovido.
- `src/audio/piper-runtime.ts` — resolve `PIPER_COMMAND` ou `piper` do PATH.
- `src/audio/outputs/home-assistant-alexa.ts` — adapter Alexa/HA.

### Configuração/health

- `src/config/runtime-settings.ts` — schema/defaults/merge/env.
- `src/config/runtime-settings-store.ts` — settings em memória/Postgres.
- `src/infrastructure/postgres-migration.ts` — resolve migration source/dist.
- `src/health/system-health.ts` — contrato/default health.
- `src/health/runtime-health.ts` — `/api/ps`, GPU, tasklist e status operacional.

### Câmeras e vídeo

- `src/cameras/camera-adapter.ts` — contrato.
- `src/cameras/rtsp-camera.ts` — captura RTSP/FFmpeg/UDP.
- `src/cameras/agent-dvr-camera.ts` — adapter Agent DVR opcional.
- `src/cameras/local-snapshot-store.ts` — snapshots, retenção e Drive backup.
- `src/cameras/live-camera-stream.ts` — MJPEG legado.
- `src/cameras/live-video-stream.ts` — H.264/MPEG-TS/FFmpeg.
- `src/cameras/google-drive-backup.ts` — upload/readback Drive.

### Detector/OCR

- `src/vision/onnx-person-detector.ts` — YOLO11n pessoa.
- `src/vision/onnx-object-inference.ts` — classes COCO.
- `src/vision/object-detection-worker.ts` — worker genérico.
- `src/vision/detector-supervisor.ts` — supervisor limitado.
- `src/vision/detector-status.ts` — status file.
- `src/vision/ocr-engine.ts` — RapidOCR/worker.
- `src/vision/ocr-observation-worker.ts` — OCR sob demanda.
- `src/vision/run-person-detector.ts` — CLI pessoa.
- `src/vision/run-object-detector.ts` — CLI objetos.
- `src/vision/run-ocr.ts` — CLI OCR.
- `src/vision/run-detector-supervisor.ts` — CLI supervisor.
- `src/vision/run-detector-status.ts` — CLI status.

### DVR, indexação e retenção

- `src/recordings/recording-profile.ts` — perfis.
- `src/recordings/ffmpeg-recorder.ts` — segmentos H.264/AAC.
- `src/recordings/recording-store.ts` — catálogo em memória/Postgres.
- `src/recordings/recording-file.ts` — validação de path.
- `src/recordings/recording-indexer.ts` — objetos/OCR em gravações.
- `src/recordings/recording-frame-extractor.ts` — frames.
- `src/recordings/recording-drive-archive.ts` — archive Drive.
- `src/recordings/recording-upload-queue.ts` — fila idempotente/retry.
- `src/recordings/recording-retention.ts` — retenção local.
- `src/recordings/recording-remote-retention.ts` — retenção remota.
- schedulers/CLIs correspondentes em `src/recordings/*scheduler.ts` e `run-*.ts`.

### Tags, timeline, notificações

- `src/tags/tag-schema.ts`, `src/tags/tag-service.ts` — tags derivadas/evidência.
- `src/timeline/timeline-service.ts` — timeline unificada.
- `src/importance/importance-policy.ts`, `importance-store.ts` — importância determinística.
- `src/watch/watch-session.ts`, `watch-session-store.ts` — watch sessions.
- `src/actions/action-policy.ts`, `action-store.ts` — propostas sem confirmação/execução HTTP.
- `src/notifications/person-notification.ts` — Telegram informativo opcional.

### Web

- `web/src/App.tsx` — shell e páginas; ainda é um componente grande com páginas históricas/atuais.
- `web/src/api/client.ts` — cliente HTTP tipado.
- `web/src/audio/audio-dashboard.tsx` — settings, quota e retenção.
- `web/src/audio/audio-session-actions.ts` — confirmação/remoção local da lista.
- `web/src/audio/push-to-talk.ts` — latch e eventos.
- `web/src/audio/audio-input.ts` — seleção de microfone/constraints.
- `web/src/cameras/live-video-player.ts` — player MPEG-TS.
- `web/src/app-model.ts` — navegação/modelo de páginas.
- `web/src/main.tsx` — entrada React.
- `web/src/styles/app.css` — estilos.

### Scripts e spikes

- `scripts/pc_voice_hotkey.py` — hotkey manual Windows.
- `scripts/faster_whisper_worker.py` — worker Python residente.
- `scripts/benchmark-stt.ts` — benchmark local/Groq opcional.
- `spikes/001-detector-benchmark/` — dataset, modelos/resultados e scripts de avaliação do detector.

Não editar `dist/` manualmente: é artefato gerado.

---

## 7. Contrato de IA, tools e segurança

### Prompt/orquestração

`ConversationOrchestrator`:

- responde em PT-BR;
- exige evidência e evita inventar estado;
- pode chamar tools read-only;
- executa no máximo três rodadas;
- registra input, tool calls, decisões, resultados e resposta em `audit_log`;
- anexa imagem ao contexto do Gemma apenas quando `get_camera_snapshot` retorna snapshot;
- público/auditoria recebe metadata e `imageRef`, não base64 bruto;
- grava `vision.observation` para interpretação de snapshot.

### Tools atuais

As tools padrão conhecidas são:

- `get_home_state`
- `get_house_knowledge`
- `search_events`
- `find_object`
- `get_camera_snapshot`
- `search_object_observations`
- `search_ocr`
- `get_detector_status`
- `search_recordings`
- `get_recording`
- `get_timeline`

Todas são de leitura. `ToolRegistry` rejeita tool desconhecida, valida argumentos com Zod, avalia risco e audita cada etapa.

### Policy Engine

`src/policies/policy-engine.ts`:

- `read`, `low`, `medium`: permitidos pela política atual;
- `critical`: bloqueado com `critical writes are blocked by default`;
- não adicionar confirmação/execução física sem uma decisão de arquitetura nova.

### Grounding Guard

Perguntas como “tem alguém?”, “quem está aí?” e “quantas pessoas?” exigem evidência live bem-sucedida (`get_camera_snapshot`, sensor live etc.). Sem evidência, a resposta é calibrada para “não é possível confirmar”.

### Detector

- YOLO11n via `onnxruntime-node`;
- `CPUExecutionProvider` de propósito;
- entrada padrão 640x640;
- limiar pessoa 0.35;
- confirmação 2 frames em até 5 s;
- publicação de eventos somente com `--publish`;
- `dry-run` é default;
- sem identidade facial: sujeito `unknown`;
- processo não inicia junto com `npm run dev`;
- status em `data/detector/status.json`;
- alertas Telegram são informativos e não acionam automações.

### Câmera

- lógica: `front`;
- URL RTSP somente em `.env`;
- transporte UDP por default;
- entrada real observada: HEVC `1920x2160`, 15 FPS, áudio PCM;
- vídeo oficial: H.264/MPEG-TS por FFmpeg, largura default 1280;
- player web `mpegts.js` sem stash buffer/chasing de latência;
- `/live-video`: fluxo contínuo;
- `/live`: MJPEG legado;
- `/preview`: JPEG pontual;
- `/health`: read-only, não cria evento nem salva JPEG;
- não há metadados comprovando PTZ/tracking físico; não inferir isso.

---

## 8. Áudio — contrato e comportamento

### Fluxo

```text
MediaRecorder ou hotkey
  -> POST /audio/pc (payload bounded)
  -> AudioPipeline
  -> AudioRuntime/SttRouter
  -> transcript PT-BR
  -> ConversationOrchestrator/Gemma
  -> Piper WAV
  -> navegador/PC speaker
```

### STT config

`SttRuntimeConfig`:

```text
route: local | groq | auto
localModel: medium | small | base
groqModel: whisper-large-v3-turbo | whisper-large-v3
language: string, default pt-BR
prompt: max 1000 chars
fallback: none | local
timeoutMs: 100..120000, default 12000
cloudEnabled: boolean, default false
```

Allowlist backend:

- modelos locais: `medium`, `small`, `base`;
- Groq: `whisper-large-v3-turbo`, `whisper-large-v3`;
- não aceitar path/modelo arbitrário pela dashboard/API.

### Rotas

- `local`: sempre Faster-Whisper local;
- `groq`: exige `cloudEnabled`, provider Groq e chave;
- `auto`: usa Groq quando cloud está habilitado e provider configurado; sem provider retorna para local;
- `fallback=local`: fallback só para timeout, upstream ou quota; credencial inválida/formato inválido/resposta inválida não devem ser mascarados.

### Groq

`GroqSttProvider`:

- usa `fetch`/`FormData` nativos;
- endpoint de transcrição multipart;
- envia nome de arquivo coerente com MIME;
- força temperatura zero;
- envia idioma português;
- usa `verbose_json`;
- normaliza `pt` para `pt-BR` no resultado;
- não inclui resposta upstream inteira em erro;
- não imprime chave;
- captura headers rate-limit em metadata segura;
- classifica 401/403 como configuração, 413 como input, 429 como quota, 5xx como upstream e abort como timeout.

A rota cloud nunca deve ser habilitada só porque uma chave existe no `.env`. Exige decisão explícita e confirmação da fronteira cloud na API/dashboard.

### Quota

`SttQuotaGuard` controla localmente:

- requests por dia;
- segundos de áudio faturáveis por dia;
- custo estimado mensal UTC;
- arredondamento/minimum billed duration de 10 s;
- idempotência por `sessionId`;
- bloqueio antes de chamada cloud;
- fallback local quando configurado e quota bloqueia.

Defaults atuais:

```text
30 requests/dia
600 segundos/dia
US$ 1 estimado/mês
```

O custo local é aproximação. Confirmar preços/headers/limites da organização Groq no console; não implementar rodízio de contas/chaves para contornar quota.

### Worker local

- `scripts/faster_whisper_worker.py` é residente;
- Faster-Whisper roda CPU/int8;
- o runtime mantém uma cadeia de processos Python para o worker no Windows; dois PIDs na árvore podem ser launcher/runtime, não necessariamente dois modelos;
- o teste de runtime garante fechamento antes de criação em hot-swap;
- não carregar modelo STT na GPU.

### Piper/TTS

- modelo protegido: `pt_BR-jeff-medium`;
- arquivo: `models/tts/piper/pt_BR-jeff-medium.onnx`;
- executável resolvido por `PIPER_COMMAND` ou `piper` no PATH;
- não voltar a forçar `python -m piper` com o Python do runtime Hermes;
- Azure é opcional, separado e não foi promovido;
- Piper real já foi testado gerando WAV.

### Sessão/telemetria

`AudioSession` persiste:

- id/source/status;
- timestamps;
- `pipelineLatencyMs` opcional;
- transcript com provider/model/localização/latência/confiança/duração/rate limit;
- resposta textual;
- target/provider TTS;
- erro;
- `conversationId`.

O transcript conserva a latência do provider. `pipelineLatencyMs` é o total STT → Gemma → TTS. Sessões antigas podem não ter `pipelineLatencyMs`; a UI mostra `—`.

Áudio bruto/base64 não é persistido em `audio_sessions`, eventos, auditoria ou settings.

---

## 9. Runtime settings e dashboard

### Settings persistentes

- Singleton `jarvis_runtime_settings` em PostgreSQL;
- fallback em memória para testes;
- schema allowlisted;
- settings nunca carregam `GROQ_API_KEY`, URL RTSP, DB URL, paths perigosos, Tailscale, GPU ou ações físicas;
- mudança de STT pode aplicar runtime sem restart;
- mudança de `audioEnabled` normalmente informa `restartRequired`;
- mudança de quota atualiza guard em memória;
- falha de provider/quota tenta restaurar settings anteriores.

### Dashboard Configurações

Campos editáveis:

- rota local/Groq/automático;
- modelo local allowlisted;
- modelo Groq allowlisted;
- idioma;
- prompt contextual;
- fallback;
- timeout;
- quota;
- auto-delete;
- dias de retenção;
- statuses deletáveis.

Campos protegidos:

- Piper/modelo TTS;
- chave Groq;
- DB/RTSP/Tailscale/GPU/paths;
- ações físicas.

Ativar cloud pela UI exige `confirmCloudBoundary=true` e chave presente no backend. Sem isso:

- `400 cloud_confirmation_required`, ou
- `409 groq_credentials_unavailable`.

### Cliente web

- APIs comuns timeout de 30 s;
- `/audio/pc` timeout próprio de 180 s, pois inclui STT + Gemma + Piper;
- seleção de microfone não persiste `deviceId`;
- botão push-to-talk suporta pointer/teclado/latch;
- dashboard mostra provider/localização/modelo/latências;
- histórico antigo sem total mostra `—`.

---

## 10. Retenção e exclusão de sessões

### O que a limpeza faz

```text
preview com before/status/ids
  -> nonce preview com TTL
  -> confirmação exata APAGAR N SESSÃO(ÕES)
  -> revalida id + status + startedAt
  -> redaction auditada por conversationId
  -> delete bounded de audio_sessions
  -> tombstone policy_decision preservado
  -> resultado/readback
```

Permitidos:

- status `completed`;
- status `failed`;
- data anterior ao corte;
- até 500 IDs explícitos.

Protegidos:

- `recording`, `transcribing`, `responding`, `speaking`;
- sessões que mudaram de status depois do preview;
- gravações/DVR;
- snapshots;
- Drive;
- linhas estruturais do audit log;
- conversas não vinculadas.

O serviço revalida status e `startedAt` na execução para evitar corrida com sessão ativa. A auditoria da conversa vinculada é redigida, mantendo timestamp/actor/outcome/fato da operação. O tombstone da purga continua no audit log.

### Auto-retention

- desligada por default;
- scheduler lê settings efetivos;
- só considera `completed`/`failed` mais antigos que `retentionDays`;
- usa actor `scheduler`;
- não deve ser ativada automaticamente pelo Codex.

### Estado real

Preview real anterior a 2026-08-07 retornou `count=0`. Nenhuma sessão real do usuário foi apagada. A exclusão foi coberta em memória e pela fixture PostgreSQL sintética, que passou com o banco saudável.

---

## 11. DVR, snapshots, Drive e retenção

### Snapshot

- diretório default: `data/snapshots`;
- retenção antiga: 7 dias;
- não apagar antes de backup verificado quando Drive está configurado;
- snapshot backup separado do DVR;
- `LocalSnapshotStore` mantém referências locais e metadata.

### DVR

Perfis:

- `continuous-economic`: 1280x1440, 5 FPS, H.264, bitrate reduzido, segmento de 60 s;
- `event-high-quality`: 1920x2160, 10 FPS, bitrate maior, segmento de 15 s;
- `manual-export`: duração do comando.

Defaults:

- contínuo: 30 dias;
- eventos: 90 dias;
- `protected`: retenção manual;
- staging só pode ser removido após readback verified;
- retenção começa em dry-run;
- Drive upload/retention são opt-in;
- delete remoto usa lixeira por default;
- delete permanente exige flag explícita.

O stream copy não foi promovido porque a câmera entrega timestamps inválidos; a transcodificação explícita é intencional.

### Drive

- OAuth/token pertence ao perfil Hermes ativo, não ao Core;
- token esperado em algo equivalente a `%LOCALAPPDATA%/hermes/profiles/jarvis/google_token.json` conforme `HERMES_HOME`;
- upload exige ID explícito para archive manual;
- fila automática somente com `JARVIS_RECORDING_BACKUP_ENABLED=true` e Drive autenticado;
- upload faz readback e marca `verified`;
- preserva cópia local por default;
- retenção remota separada e opt-in.

### Investigação do alerta de snapshot retention

O scheduler de snapshots vinha registrando:

```text
Snapshot retention: scanned=94 uploaded=0 deleted=0 failed=94 skipped=false
```

A investigação local encontrou a causa operacional mais provável, sem fazer chamada ao Drive:

- o runtime Python usado no host não consegue importar `googleapiclient` nem `google`;
- o script local `google_api.py` e o token do perfil Hermes estão presentes, mas o executável `gws` não está disponível;
- a documentação do perfil indica instalação das dependências Python como pré-requisito.

Isso é consistente com os 94 uploads falhando antes de qualquer remoção. Nenhum upload, delete, instalação de dependência, leitura de token ou chamada externa foi feito nesta investigação. O comportamento não destrutivo permanece: `uploaded=0` e `deleted=0`. Para resolver, será necessário autorizar a preparação do ambiente Python/Drive e depois repetir um teste controlado; não instalar dependências nem ativar retenção remota automaticamente.

---

## 12. Banco e migrations

Arquivos:

- `infrastructure/postgres/001_init.sql`
- `infrastructure/postgres/002_recordings.sql`
- `infrastructure/postgres/003_audio_sessions.sql`
- `infrastructure/postgres/004_runtime_settings.sql`

### `events`

- id, tipo, timestamp, origem, location, subject, confidence, data JSONB;
- coluna `embedding VECTOR` disponível, mas nenhum modelo de embedding está ativo;
- índices por timestamp/tipo/location.

### `audit_log`

- id, occurred_at, conversation_id, kind, action, actor, outcome, data JSONB;
- índices por timestamp/conversation;
- redaction altera conteúdo, preserva trilho estrutural.

### `recording_segments`

- câmera, intervalo, duração, fileRef, bytes, MIME, codecs, dimensões, checksum;
- backup status;
- Drive ID/link/timestamp verified;
- `retention_tier`: continuous/event/protected;
- `protected` boolean.

### `audio_sessions`

- id/source/status/timestamps;
- `pipeline_latency_ms DOUBLE PRECISION` adicionado aditivamente;
- transcript JSONB;
- response text;
- TTS target/provider;
- error;
- conversation_id.

`003_audio_sessions.sql` contém `ALTER TABLE ... ADD COLUMN IF NOT EXISTS pipeline_latency_ms`, portanto sessões antigas podem ter NULL.

### `jarvis_runtime_settings`

Singleton id=1, `settings JSONB`, `updated_at`.

### `stt_usage_records`

- `session_id` PK;
- `usage_day`;
- `audio_seconds`;
- `estimated_usd`;
- índice por dia;
- agregação mensal feita por intervalo de datas.

### Teste de migration em `dist`

`src/infrastructure/postgres-migration.ts` corrige o problema de caminho entre source e compilado. O teste `tests/postgres-migration-path.test.ts` simula módulo em `dist`.

---

## 13. API HTTP completa

Todas as rotas estão em `src/app.ts`. O Core não tem autenticação de aplicação própria; a proteção de rede depende de bind loopback + Tailscale ACL/Serve. Não expor diretamente.

### Root/saúde

```text
GET  /
GET  /health
GET  /system/health
```

`/` lista endpoints. `/health` é básico. `/system/health` inclui:

- Core/model/database/recordings/audio;
- Ollama e modelos carregados;
- GPU/memória/utilização;
- contagem de processos;
- provider STT efetivo;
- localização local/cloud;
- fallback;
- quota;
- exposição/bind.

### Conversa/eventos/auditoria

```text
POST /conversation
GET  /events
POST /events
GET  /events/:id
GET  /evidence/:id
GET  /audit
GET  /timeline
```

Exemplo seguro:

```bash
curl -X POST http://127.0.0.1:3000/conversation \
  -H 'content-type: application/json' \
  -d '{"message":"Tem alguém no quintal?"}'
```

### Settings

```text
GET /settings
PUT /settings
```

Exemplo somente local, sem cloud:

```bash
curl -X PUT http://127.0.0.1:3000/settings \
  -H 'content-type: application/json' \
  -d '{"stt":{"route":"local","localModel":"medium"}}'
```

Não enviar chave no payload. Não imprimir resposta completa se ela contiver prompt/configuração sensível.

### Áudio

```text
GET    /audio/sessions
GET    /audio/sessions/:id
POST   /audio/pc
POST   /audio/sessions/delete-preview
DELETE /audio/sessions
```

O payload de `/audio/pc`:

```json
{
  "mimeType": "audio/wav|audio/webm|audio/ogg|audio/mpeg",
  "audioBase64": "...bounded..."
}
```

A resposta contém session/conversation e áudio de resposta em base64 para reprodução imediata; isso não significa que o áudio foi persistido.

Preview:

```bash
curl -X POST http://127.0.0.1:3000/audio/sessions/delete-preview \
  -H 'content-type: application/json' \
  -d '{"before":"2026-08-07T00:00:00.000Z","statuses":["completed","failed"]}'
```

Use o `count` retornado para formar a confirmação exata. Não inventar previewId nem confirmation.

### Câmeras

```text
GET /cameras/:camera/health
GET /cameras/:camera/preview
GET /cameras/:camera/live
GET /cameras/:camera/live-video
```

### Gravações

```text
GET /recordings
GET /recordings/:id
GET /recordings/:id/clip
```

`/clip` valida que `fileRef` não escapa de `JARVIS_RECORDING_OUTPUT_DIR`.

### Tags/watch/importância/actions

```text
GET /tags
GET /tags/:id
GET /watch-sessions
GET /watch-sessions/:id
GET /importance
GET /importance/:id
GET /actions/proposals
GET /actions/proposals/:id
```

Ações são apenas propostas. Não há endpoint de confirmação/execução física nesta fase.

---

## 14. Variáveis de ambiente

O template completo está em `.env.example`. O `.env` real não deve ser copiado para o handoff.

### Core/Ollama

```text
HOST=127.0.0.1
PORT=3000
JARVIS_MODEL=gemma-hermes:latest
OLLAMA_BASE_URL=http://127.0.0.1:11434
DATABASE_URL=<segredo>
JARVIS_CORE_BASE_URL=http://127.0.0.1:3000
```

### Postgres/segredo local

```text
POSTGRES_DB
POSTGRES_USER
JARVIS_POSTGRES_PASSWORD
POSTGRES_PORT=5434
```

O Compose usa default local de desenvolvimento para senha quando não substituído; não assumir isso em produção.

### Câmera/RTSP

```text
JARVIS_CAMERA_FRONT_RTSP_URL=<segredo>
JARVIS_RTSP_TRANSPORT=udp
JARVIS_CAMERA_FRONT_LOCATION=frente
FFMPEG_PATH=ffmpeg
JARVIS_LIVE_VIDEO_WIDTH=1280
```

### Audio/STT

```text
JARVIS_AUDIO_ENABLED=false
JARVIS_STT_MODEL=medium
JARVIS_STT_ROUTE=local
JARVIS_STT_LANGUAGE=pt-BR
JARVIS_STT_FALLBACK=none
JARVIS_STT_TIMEOUT_MS=12000
JARVIS_GROQ_STT_MODEL=whisper-large-v3-turbo
JARVIS_STT_MAX_REQUESTS_PER_DAY=30
JARVIS_STT_MAX_AUDIO_SECONDS_PER_DAY=600
JARVIS_STT_MAX_ESTIMATED_MONTHLY_USD=1
JARVIS_AUDIO_SESSION_AUTO_DELETE=false
JARVIS_AUDIO_SESSION_RETENTION_DAYS=30
JARVIS_AUDIO_SESSION_RETENTION_INTERVAL_MS=86400000
JARVIS_PIPER_MODEL=models/tts/piper/pt_BR-jeff-medium.onnx
PIPER_COMMAND=piper
JARVIS_VOICE_HOTKEY=ctrl+alt+j
```

Gates cloud:

```text
JARVIS_CLOUD_STT_ENABLED=false
JARVIS_CLOUD_TTS_ENABLED=false
GROQ_API_KEY=<backend secret, never dashboard/log>
```

O runtime settings da dashboard usa `cloudEnabled`; manter ambos os gates/cloud defaults coerentes.

### Detector/OCR

```text
JARVIS_ONNX_MODEL_PATH=spikes/001-detector-benchmark/models/yolo11n.onnx
JARVIS_ONNX_INPUT_SIZE=640
JARVIS_DETECTOR_CAMERA=front
JARVIS_DETECTOR_INTERVAL_MS=1000
JARVIS_DETECTOR_STATUS_FILE=data/detector/status.json
JARVIS_DETECTOR_STATUS_MAX_AGE_MS=30000
JARVIS_DETECTOR_CONFIDENCE_THRESHOLD=0.35
JARVIS_DETECTOR_CONFIRMATION_FRAMES=2
JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS=5000
JARVIS_DETECTOR_EXCLUDED_REGIONS=<JSON opcional>
JARVIS_OBJECT_DETECTOR_CLASSES=person,car,motorcycle,bicycle,cat,dog,truck
JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD=0.35
JARVIS_OBJECT_DETECTOR_CONFIRMATION_FRAMES=2
JARVIS_OBJECT_DETECTOR_CONFIRMATION_WINDOW_MS=5000
JARVIS_OCR_PYTHON=<opcional>
JARVIS_OCR_WORKER=tools/ocr/rapidocr_worker.py
JARVIS_OCR_EXCLUDED_REGIONS=<JSON opcional>
JARVIS_OCR_CAMERA=front
JARVIS_OCR_MODEL=rapidocr-onnxruntime
```

### DVR/Drive

```text
JARVIS_RECORDING_CAMERA=front
JARVIS_RECORDING_OUTPUT_DIR=data/recordings
JARVIS_RECORDING_DURATION_MS=10000
JARVIS_RECORDING_VIDEO_FPS=5
JARVIS_RECORDING_VIDEO_PRESET=ultrafast
JARVIS_RECORDING_RETRY_DELAY_MS=5000
JARVIS_RECORDING_PROFILE=continuous-economic
JARVIS_RECORDING_MAX_AGE_DAYS=30
JARVIS_RECORDING_EVENT_MAX_AGE_DAYS=90
JARVIS_RECORDING_RETENTION_DRY_RUN=true
JARVIS_RECORDING_MAX_BYTES=50000000000
JARVIS_RECORDING_BACKUP_ENABLED=false
JARVIS_RECORDING_BACKUP_INTERVAL_MS=3600000
JARVIS_RECORDING_UPLOAD_MAX_ATTEMPTS=5
JARVIS_RECORDING_UPLOAD_RETRY_DELAY_MS=2000
JARVIS_RECORDING_REMOTE_RETENTION_ENABLED=false
JARVIS_RECORDING_REMOTE_RETENTION_INTERVAL_MS=86400000
JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY=false
JARVIS_DRIVE_PERMANENT_DELETE=false
JARVIS_DRIVE_PARENT_FOLDER_ID=<opcional/segredo operacional>
```

### Notificação/Tailscale

```text
JARVIS_TELEGRAM_NOTIFICATION_TARGET=<opcional/segredo operacional>
JARVIS_TAILSCALE_SERVE_ENABLED=false
```

A flag de Tailscale não cria proxy; usar `tailscale serve status`.

---

## 15. Dashboard e arquivos de documentação

URLs:

```text
http://127.0.0.1:3000/ui/
https://pc.tail14bdd9.ts.net/ui/
```

Documentos principais:

- `README.md` — execução, CLI, endpoints e configuração geral;
- `JARVIS_AI_MAP.md` — IA ativa, experimental, planejada e fronteira read-only;
- `docs/audio-architecture.md` — áudio/STT/TTS/retention/privacy;
- `docs/stt-benchmark-template.md` — benchmark e interpretação;
- `docs/web-interface.md` — dashboard e fluxo web;
- `docs/tailscale-serving.md` — exposição segura;
- `docs/recording-and-drive.md` — DVR/Drive/retention;
- `docs/tagging-and-importance.md` — tags/watch/importância;
- `.hermes/plans/2026-09-05_215145-stt-groq-dashboard-sessoes.md` — plano e evidências da fase;
- `.hermes/plans/2026-08-29_005004-jarvis-core-v0-1.md` — plano anterior do Core V0.1;
- `CODEX_HANDOFF.md` — este handoff.

---

## 16. Testes e evidências

### Suíte completa com ambiente explícito





Comando:

```powershell
node --env-file=.env .\node_modules\vitest\vitest.mjs run
```

Resultado:

```text
113 arquivos passaram
283 testes passaram
```

Esse é o resultado completo válido porque carrega o `.env` explicitamente. O `npm test` sem ambiente não é a métrica final desta fase: os testes que dependem de PostgreSQL não podem ser tratados como prova de integração.

### Build

O `npm run build` passou após as alterações do supervisor e do teste de retenção (TypeScript + Vite). O Vite emitiu somente o aviso já conhecido de chunk grande; não houve erro de compilação.

### Testes PostgreSQL explícitos

Quando o Postgres estava saudável:

```bash
node --env-file=.env node_modules/vitest/vitest.mjs run \
  tests/postgres-audio-session-store.test.ts \
  tests/postgres-stt-usage-store.test.ts
```

Resultado: `2/2` passaram. Fixtures foram limpos:

- `test-pg-audio-session-001`;
- `test-pg-stt-usage-001-*`.

### Testes relevantes da fase

- `tests/groq-stt.test.ts` — multipart, idioma, prompt, erros, timeout, quota/header;
- `tests/stt-config.test.ts` — allowlists/defaults;
- `tests/stt-router.test.ts` — local/cloud/auto/fallback/quota;
- `tests/stt-usage.test.ts` — idempotência, billing mínimo e teto mensal;
- `tests/stt-quota-update.test.ts` — update de limites;
- `tests/audio-runtime.test.ts` — hot-swap serializado, rollback e health;
- `tests/audio-pipeline.test.ts` — transcript latency vs pipeline latency;
- `tests/audio-session-retention.test.ts` — preview/confirmation/redaction/race;
- `tests/audio-session-retention-api.test.ts` — rotas HTTP;
- `tests/audio-session-retention-scheduler.test.ts` — auto-retention off/opt-in;
- `tests/settings-api.test.ts` — schema, cloud confirmation e redaction;
- `tests/runtime-settings.test.ts` e `runtime-settings-store.test.ts`;
- `tests/web-settings-client.test.ts`;
- `tests/web-audio-client.test.ts` — timeout 180 s;
- `tests/web-audio-session-actions.test.ts`;
- `tests/piper-runtime-command.test.ts`;
- `tests/postgres-migration-path.test.ts`.
- `tests/windows-supervisor-contract.test.ts` — Validate/Status redigidos, defaults seguros e contrato do supervisor.
- `tests/postgres-audio-session-retention.test.ts` — fixture sintético de preview, confirmação, corrida, redaction/tombstone e preservação de recording/Drive.

O teste focado do supervisor passou em `3/3`. A fixture PostgreSQL passou em `1/1` após o reinício do Docker. Durante a validação, ela revelou e permitiu corrigir um cast ausente em `src/audit/postgres-audit-store.ts`; os timestamps da fixture também foram tornados determinísticos para respeitar a ordenação contratada.

### Benchmarks reais

Fixture:

```text
data/audio/tts/piper-smoke.wav
```

É áudio sintetizado pelo Piper, não fala humana. Não usar como gate de qualidade PT-BR.

Benchmark direto local previamente executado:

- Faster-Whisper `medium`;
- aproximadamente 13,36 s em execução fria;
- confiança observada aproximadamente 0,6976;
- Groq foi marcado como skip naquele momento por ausência de chave.

Smoke integrado local previamente executado:

- sessão `completed`;
- STT local aproximadamente 6,34 s em execução aquecida;
- pipeline total aproximadamente 21,64 s;
- Piper respondeu;
- nenhum áudio bruto no readback;
- Gemma foi o único modelo neural observado na GPU durante o smoke.

Piper direto:

- executável `piper` real;
- aproximadamente 2,14 s;
- WAV gerado com sucesso.

### Boot de produção

Validado:

```bash
npm start
```

Em porta isolada `3001`, com Postgres saudável, `dist/src/server.js` iniciou e respondeu `/system/health` com `ok`. A instância auxiliar foi encerrada depois.

### Smoke operacional durável

- O segundo smoke bem-sucedido reutilizou PostgreSQL healthy, aguardou Ollama/modelo, iniciou o Core compilado em loopback e mostrou no `Status` os PIDs próprios com seus horários de início.
- Os readbacks somente leitura de `/health`, `/system/health`, `/settings` e sessões de áudio responderam; a RTX 4060 permaneceu como único ocupante neural observado.
- A primeira parada revelou uma corrida entre o marcador e o supervisor; o protocolo marcador/mutex foi corrigido. No smoke seguinte, o log registrou `Stop request received` e encerrou somente Core/Ollama próprios. O arquivo de estado e o marcador foram removidos; PostgreSQL externo permaneceu ativo naquele momento.
- A instalação da tarefa `Jarvis Core` foi relida após o registro. A verificação de propriedades confirmou ação, comando, diretório de trabalho, usuário, trigger, usuário do trigger e settings; a tarefa ficou em estado `Ready`.

---

## 17. Pendências desta fase

### P0 — obrigatório antes de promover Groq

1. Confirmar com o responsável se a chave presente em `.env` pode ser usada para uma chamada cloud de teste.
2. Não imprimir nem copiar a chave.
3. Rodar o benchmark com uma fixture autorizada e não sensível.
4. Comparar `medium`, `whisper-large-v3-turbo` e `whisper-large-v3`.
5. Medir p50/p95, WER/CER, nomes próprios, comandos, ruído e custo.
6. Só então decidir entre manter `local`, usar `auto` ou promover `groq`.

Comando:

```bash
npm run benchmark:stt -- --audio <fixture.wav> --expected "<frase PT-BR redigida>"
```

Não declarar que a qualidade do STT foi resolvida antes dessa rodada.

### P1 — validação de retenção

O teste `tests/postgres-audio-session-retention.test.ts` foi criado com fixture sintético e passou com o PostgreSQL saudável, cobrindo o readback completo:

- preview seleciona somente o fixture;
- confirmação exige quantidade exata;
- sessão é removida;
- conversa vinculada é redigida;
- tombstone fica presente;
- sessão ativa concorrente não é removida;
- gravações/Drive não são afetados.

Não apagar as 20/29 sessões reais recentes apenas para produzir uma evidência. A fixture removeu somente os IDs sintéticos e fez cleanup ao final; nenhuma sessão real foi removida.

### P1 — operação durável

Implementado em `ops/windows/jarvis-supervisor.ps1` e documentado em `docs/windows-operation.md`. A tarefa `Jarvis Core` foi instalada no contexto do usuário escolhido e passou por readback de propriedades. O supervisor mantém a ordem PostgreSQL → Ollama → Core, readiness limitado, backoff 5/15/30 s, instância única, logs sem segredos, identidade de PID e parada coordenada.

A tarefa inicia somente o Core supervisor no login; não inicia detector, hotkey, gravação contínua, Drive ou ações físicas. O Docker Desktop continua sendo pré-requisito externo; após a validação, o container PostgreSQL foi parado e o estado final do Jarvis ficou parado.

### P1 separado — snapshot retention

A investigação local foi concluída sem tocar no Drive: os imports `googleapiclient` e `google` estão ausentes no Python usado pelo host, enquanto o script/token do perfil Hermes existem. Isso explica de forma consistente o `failed=94` e o `uploaded=0/deleted=0`. O alerta continua não resolvido operacionalmente; a próxima ação exige autorização para preparar as dependências Python/Drive e executar uma validação controlada.

Não instalar dependências, ler credenciais, subir o Drive ou ativar retenção remota automaticamente.

### P2 — decisão de default

Após benchmark humano:

- se Groq vencer e privacidade/custo forem aceitáveis: considerar `auto + cloudEnabled + fallback=local`;
- se local vencer após ajuste: manter local;
- se nenhum vencer: revisar captura, VAD, duração, microfone e dataset antes de trocar mais modelos.

---

## 18. Decisões que não devem ser revertidas sem discussão

1. **Cloud é opt-in.** Ausência de chave, quota ou confirmação não envia áudio.
2. **Piper fica local e protegido.** Não alterar voz/modelo sem necessidade.
3. **No máximo um modelo neural na GPU.** Gemma é o ocupante esperado; detector/STT/TTS usam CPU.
4. **Não usar rotação de múltiplas contas Groq** para contornar quota.
5. **Não persistir áudio bruto.** Sessões guardam transcript/metadata, não base64.
6. **Retenção de sessão exige preview + quantidade + revalidação.**
7. **Auditoria deve ser redigida, não apagada fisicamente.** Tombstone é obrigatório.
8. **Ações físicas continuam bloqueadas.** O modelo pode propor/interpreter; Core controla.
9. **Detector continua manual/dry-run por default.**
10. **Tailscale Serve, não Funnel.** Core continua loopback.
11. **DVR/Drive deletions continuam conservadoras.** Backup/readback antes de apagar.
12. **Não assumir PTZ/tracking/identidade facial** sem evidência específica.
13. **Não editar `dist/` manualmente.** Rebuild.
14. **Não fazer `git reset` ou criar branch assumindo que existe Git.** O diretório não tem `.git` detectável.

---

## 19. Procedimento recomendado para o próximo turno do Codex

### Passo A — inspeção

```bash
cd C:/Users/davi/jarvis
npm test
npm run build
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
tailscale serve status
```

Para a execução durável, também ler:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Validate
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Status
```

Depois verificar `11434`/`3000` antes de iniciar processos.

### Passo B — operação durável sem duplicar

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Start
```

Use processos acompanhados e checks de readiness. O Docker Desktop precisa estar disponível para o `Start`; se uma porta já estiver aberta, não iniciar outro processo. O áudio continua opt-in e não é habilitado pelo Task Scheduler.

### Passo C — smoke local

```bash
curl http://127.0.0.1:3000/system/health
curl http://127.0.0.1:3000/settings
curl http://127.0.0.1:3000/audio/sessions?limit=5
```

Abrir:

```text
https://pc.tail14bdd9.ts.net/ui/#settings
https://pc.tail14bdd9.ts.net/ui/#audio
```

Ao finalizar o smoke, usar a parada coordenada:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Stop
```

### Passo D — cloud somente com decisão

Antes da primeira chamada Groq, confirmar:

- chave presente e autorizada, sem imprimir valor;
- usuário autorizou envio cloud;
- fixture não sensível;
- quota local definida;
- fallback definido;
- custo esperado conhecido;
- resultado será documentado sem transcript pessoal bruto.

### Passo E — atualização de documentação

Após o benchmark:

- atualizar `docs/stt-benchmark-template.md` com resultado sanitizado;
- atualizar `JARVIS_AI_MAP.md` separando ativo/experimental;
- atualizar este handoff com decisão e evidência;
- não registrar a chave, tokens, áudio ou conteúdo pessoal.

---

## 20. Critério de encerramento da próxima etapa

A fase estará realmente encerrada quando:

- [ ] Groq live tiver sido testado com autorização;
- [ ] benchmark humano PT-BR tiver p50/p95/WER/CER/custo;
- [ ] rota default tiver decisão baseada em dados;
- [ ] fallback tiver sido validado com erro/429 real ou mock equivalente;
- [ ] settings tiverem save/readback real pela dashboard;
- [x] fixture PostgreSQL de retenção tiver redaction/tombstone/readback;
- [x] Core/Ollama tiverem estratégia de execução durável implementada e tarefa lida de volta;
- [x] alerta de snapshot retention tiver investigação local separada e não destrutiva;
- [ ] dependências Python/Drive tiverem validação controlada autorizada;
- [x] suíte/build continuarem verdes.

Até lá, o estado seguro recomendado é:

```text
route=local
localModel=medium
cloudEnabled=false
fallback=none
autoDeleteEnabled=false
Piper=pt_BR-jeff-medium
Detector=manual/dry-run
DVR retention=conservadora
Tailscale=tailnet-only
```

---

## 21. Frase curta para iniciar uma sessão Codex

Se quiser colar um briefing curto depois de o Codex ler o arquivo:

> Leia `C:/Users/davi/jarvis/CODEX_HANDOFF.md` completamente. Faça uma inspeção read-only primeiro. O Jarvis é local-first, está em `main` com `origin/main`, e mantém Postgres/Ollama/Core separados. Não exponha segredos, não habilite Groq/autostart/ações físicas/retention destrutiva sem autorização. Preserve Piper, a exclusividade de GPU, Tailscale-only, redaction+tombstone e o fluxo TDD. Depois me mostre o estado atual e proponha somente o próximo passo bloqueado por evidência.
