# Jarvis Core — Mapa de IA atual e planejada

> Auditoria somente leitura do repositório atual. Este documento descreve o que existe no código, o que foi apenas testado no spike e o que está planejado/adiado. Não altera o runtime.

## Resumo executivo

O Jarvis Core usa atualmente **três componentes neurais no caminho padrão** e possui um caminho de áudio local pronto, mas opt-in:

1. **Gemma local via Ollama** — LLM de conversa, tool calling e VLM quando recebe uma imagem da câmera.
2. **YOLO11n via ONNX Runtime** — detector de pessoas e classes COCO selecionadas, separado do LLM.
3. **RapidOCR via ONNX** — OCR sob demanda em snapshots ou frames históricos.
4. **Áudio roteado opt-in** — `SttRouter` escolhe Faster-Whisper `medium` residente em CPU ou Groq Whisper cloud; Piper `pt_BR-jeff-medium` continua em CPU para TTS. Cloud e o pipeline permanecem desligados por padrão.

Todo o restante é infraestrutura ou controle determinístico: eventos, PostgreSQL, World State, memória episódica/semântica, auditoria, Policy Engine, Grounding Guard, confirmação temporal, fila de upload e publicação HTTP.

## Fluxo atual

```text
Usuário
  │ POST /conversation
  ▼
ConversationOrchestrator
  │ prompt de sistema + até 3 rodadas de tools
  ▼
OllamaGateway ── POST /api/chat ──► Ollama local
                                      │
                                      ▼
                             gemma-hermes:latest
                              LLM + capacidade VLM
                                      │
                         texto / tool call read-only
                                      ▼
ToolRegistry + PolicyEngine
  ├─ get_home_state
  ├─ get_house_knowledge
  ├─ get_camera_snapshot ──► RTSP/FFmpeg ──► imagem para o Gemma
  ├─ search_events / find_object
  ├─ search_object_observations / search_ocr
  ├─ search_recordings / get_recording / get_timeline
  └─ get_detector_status
                                      │
                                      ▼
                         GroundingGuard + resposta

Câmera RTSP
  │ UDP / FFmpeg
  ▼
OnnxPersonInference ──► yolo11n.onnx / ONNX Runtime CPU
  ▼
PersonDetectionWorker
  └─ confirmação temporal: 2 observações em até 5 s
      ▼
POST /events ──► PostgreSQL + World State + Audit
      └─ Telegram opcional, somente para evento confirmado

PC microphone / push-to-talk
  │ MediaRecorder ou scripts/pc_voice_hotkey.py
  ▼
SttRouter
  ├─ Faster-Whisper CPU residente ──┐
  └─ Groq Whisper cloud (opt-in) ───┴─► transcript pt-BR ──► ConversationOrchestrator
                                      ▼
Piper CPU / Azure opcional com quota+cache ──► PC speaker ou adapter Alexa/HA

RTSP/FFmpeg ──► segmento econômico 60 s ──► catálogo
                         ├─► fila Drive resumable → readback → verified
                         └─► retenção: contínuo 30 d / eventos 90 d / protected manual
```

As duas linhas de IA são separadas: o detector não chama o Gemma, e o Gemma não controla diretamente o detector nem ações físicas.

## IA ativa no runtime

| Componente | Tecnologia/modelo | Entrada | Saída | Estado |
|---|---|---|---|---|
| Conversação | Ollama HTTP + `gemma-hermes:latest` | Mensagem do usuário, estado retornado pelas tools e histórico da rodada | Texto e chamadas de tools | Ativo |
| VLM | O mesmo Gemma via `/api/chat` com `images` | Snapshot JPEG retornado por `get_camera_snapshot` | Interpretação textual da imagem | Ativo sob demanda |
| Tool calling | Capacidade do Gemma, validada pelo `ToolRegistry` | Schemas JSON das tools read-only | Nome e argumentos de uma tool | Ativo |
| Detecção de objetos | `yolo11n.onnx` + `onnxruntime-node` | JPEG do RTSP `front` | Caixas/confiança de pessoa e classes COCO selecionadas | Ativo no worker separado |
| OCR | RapidOCR/ONNX em `tools/ocr/.venv` | Snapshot ou frame histórico selecionado | Texto, confiança e caixas | Ativo sob demanda |
| Áudio local | Faster-Whisper `medium` residente em CPU | WAV/WebM da sessão PC | Transcript PT-BR | Ativo quando rota local + áudio habilitados |
| Áudio cloud | `GroqSttProvider` com `whisper-large-v3-turbo`/`whisper-large-v3` | WAV/WebM da sessão PC | Transcript PT-BR | Implementado, opt-in, chave ausente nesta máquina |
| TTS | Piper `pt_BR-jeff-medium` | Resposta textual do Core | WAV PT-BR | Ativo quando áudio está habilitado |

O áudio não carrega modelo na GPU: Faster-Whisper usa `device=cpu/compute_type=int8`, Groq é remoto e Piper roda como processo CPU. O fallback local/cloud é determinístico e o Azure só é criado com credencial e quota explícitas.

### Gemma / Ollama

- Gateway: `src/llm/ollama-gateway.ts`.
- Contrato: `src/llm/model-gateway.ts`.
- Endpoint: `POST /api/chat` no Ollama local.
- Modelo padrão do Core: `gemma-hermes:latest`.
- O Core envia `num_ctx=8192`, `temperature=0.2` e `stream=false`.
- O modelo pode responder texto ou propor tools; não recebe permissão para executar uma ação crítica diretamente.
- A imagem da câmera é anexada somente quando uma tool retorna snapshot. O JSON público/auditoria mantém metadados e `imageRef`, não base64 bruto.
- Orquestração: `src/orchestrator.ts`, com prompt de sistema em PT-BR e no máximo três rodadas de tools.

### YOLO11n / ONNX

- Implementação: `src/vision/onnx-person-detector.ts`.
- CLI: `src/vision/run-person-detector.ts`.
- Modelo principal: `spikes/001-detector-benchmark/models/yolo11n.onnx`.
- Runtime: `onnxruntime-node`, `CPUExecutionProvider`.
- Pré-processamento: JPEG → FFmpeg → entrada quadrada padrão `640×640`.
- Pós-processamento: classe pessoa, limiar padrão `0.35` e NMS `0.45`.
- O scheduler impede inferências sobrepostas e contabiliza as que são puladas.
- Confirmação temporal padrão: 2 detecções qualificadas em até 5 segundos.
- Publicação é opt-in (`--publish`); `dry-run` é o padrão do CLI e do supervisor.
- O detector não conhece identidade: o sujeito publicado é `unknown`.

## O que parece IA, mas não é IA

| Camada | Papel |
|---|---|
| `ConversationOrchestrator` | Monta mensagens, limita rodadas, executa tools e registra auditoria |
| `ToolRegistry` | Valida argumentos, executa a tool e aplica a política |
| `PolicyEngine` | Permite tools `read` e bloqueia risco `critical` por regra determinística |
| `GroundingGuard` | Verifica se perguntas de presença têm evidência ao vivo antes de aceitar a resposta |
| `WorldStateProjection` | Projeta eventos em estado atual e ignora eventos atrasados |
| `EpisodicMemory` / `SemanticMemory` | Consulta e armazena fatos estruturados; não gera inferências por modelo |
| PostgreSQL / audit log | Persistência, busca e rastreabilidade |
| Confirmação temporal | Regra de contagem/janela, não tracker neural |
| `HttpEventPublisher` | Transporte HTTP idempotente para eventos |
| Telegram notifier | Entrega opcional de alerta informativo; não toma decisão |

## IA experimental ou planejada

| Item | Situação atual | Regra/condição |
|---|---|---|
| YOLOv9 + Frigate/TensorRT/CUDA | Testado no spike, não usado pelo Core | Sidecar somente se NVR, gravação, tracking ou dashboard justificarem o custo |
| Embeddings semânticos | Adiados | Só adicionar após necessidade medida; pgvector está disponível, mas não há modelo de embedding ativo |
| Redis | Adiado | Não é dependência da V0.1 |
| Fine-tuning | Bloqueado/adiado | Primeiro ampliar métricas e hard negatives; não treinar automaticamente |
| Groq Whisper | Implementado, mas experimental/opt-in | Exige chave backend, confirmação de saída de áudio, quota local e benchmark PT-BR antes de promoção |
| Gerenciamento de sessões | Implementado na API/dashboard | Preview + confirmação exata; redaction de conversa vinculada e tombstone de auditoria |
| Reconhecimento facial | Fora da V0.1 | Exige autorização explícita e definição de pessoas cadastradas |
| ReID corporal / identidade persistente | Fora da V0.1 | Não há modelo nem fluxo de identidade |
| Múltiplas câmeras / tracking entre cômodos | Fora da V0.1 | Requer nova arquitetura de tracking e memória |
| Cloud LLM/VLM | Não usado no caminho crítico | Processamento local é o padrão |
| Home Assistant / ESP32 / Zigbee | Fora da V0.1 | Integração futura; não é componente de IA por si só |

## Fronteira read-only

Atualmente, o Gemma só recebe tools de leitura:

- `get_home_state`
- `get_house_knowledge`
- `search_events`
- `find_object`
- `get_camera_snapshot`

Não há tool de escrita ou de ação crítica registrada. O detector pode publicar eventos estruturados apenas quando iniciado explicitamente com `--publish`; isso não abre portão, sirene, fechadura ou alarme. A inicialização automática do detector foi revertida e não está instalada.

## Decisão técnica atual

- **Gemma:** interpretar, conversar, chamar tools e analisar snapshots sob demanda.
- **YOLO11n:** perceber pessoas de forma barata e independente, em CPU.
- **Core:** validar, persistir, projetar estado, auditar e aplicar políticas.
- **Não fazer agora:** adicionar outro modelo, treinar, ativar ROI, migrar para GPU ou liberar automações físicas sem evidência ampliada.

## Atualização implementada

Desde o mapa inicial, a primeira evolução foi exercitada no código e em smoke real:

- `OnnxObjectInference` agora expõe classes COCO além de pessoa; `npm run detector:objects -- --once` é o diagnóstico seguro.
- `ObjectDetectionWorker` confirma classes por câmera e emite `object.observed` ligado a `camera.snapshot`.
- RapidOCR/ONNX foi escolhido após comparação: reconheceu texto sintético com confiança `0,992` e timestamps reais da câmera em aproximadamente `1,8–3,4 s`; Tesseract.js foi removido do Core após produzir ruído no frame inteiro.
- `OcrObservationWorker` e `npm run ocr -- --once` criam `ocr.observation` sob demanda, sem loop contínuo.
- O Gemma recebeu as tools read-only `search_object_observations`, `search_ocr`, `get_detector_status`, `search_recordings` e `get_recording`; uma conversa real consultou o catálogo de gravações corretamente.
- O DVR local agora grava segmentos H.264/AAC via FFmpeg, cataloga metadata/checksum no PostgreSQL e expõe `GET /recordings`, `GET /recordings/:id` e `GET /recordings/:id/clip`.
- O arquivador `record:archive` reutiliza o adapter do Drive, exige receipt/readback e marca o segmento como `verified` sem apagar a cópia local.
- `--continuous` existe somente como comando manual explícito; nenhum autostart foi deixado instalado.
- O benchmark sequencial do `gemma4:e2b-it-q4_K_M` confirmou economia média efetiva de aproximadamente `1.312,5 MiB` de GPU e tool calling no Core, mas o E2B interpretou dois snapshots reais como formulário/tabela; o E2B foi removido do Ollama e `gemma-hermes:latest` continua sendo o VLM padrão. Os modelos foram sempre descarregados entre rodadas.

## Fontes principais no projeto

- `src/llm/ollama-gateway.ts`
- `src/llm/model-gateway.ts`
- `src/orchestrator.ts`
- `src/tools/tool-registry.ts`
- `src/vision/onnx-person-detector.ts`
- `src/vision/run-person-detector.ts`
- `src/policies/policy-engine.ts`
- `src/grounding/grounding-guard.ts`
- `src/state/world-state.ts`
- `src/memory/memory-service.ts`
- `src/memory/semantic-memory.ts`
- `spikes/001-detector-benchmark/README.md`
- `.hermes/plans/2026-08-29_005004-jarvis-core-v0-1.md`
