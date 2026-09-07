# Jarvis Interface and Local Audio Evolution Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Construir uma interface web operacional completa e uma camada de áudio híbrida/local-first para o Jarvis, mantendo Alexa via Home Assistant para comandos e anúncios, PC/web para conversa livre, DVR pesquisável com tags semânticas e arquivamento controlado no Google Drive.

**Architecture:** O sistema será dividido em quatro planos independentes: interface web, áudio, percepção/mídia e Core determinístico. O Gemma interpreta, descreve e propõe importância; o Core valida schemas, aplica política, persiste evidências e exige confirmação para qualquer ação. Alexa não será tratada como um microfone LAN: sem uma skill AWS própria, ela será um canal híbrido de comandos reconhecidos pelo Home Assistant e saída de voz; o caminho de conversa livre será PC/web.

**Tech Stack:** Node.js 22, TypeScript, Fastify 5, Ollama/Gemma local, ONNX Runtime/YOLO, RapidOCR, FFmpeg, PostgreSQL, Google Drive API resumable uploads, React + Vite + TypeScript para a interface, Tailscale Serve, Home Assistant REST/WebSocket/Assist quando aplicável, Piper/Whisper ou Wyoming para áudio local, Azure/Google TTS somente como fallback explicitamente controlado.

---

## 1. Decisões confirmadas

### Interface

- Superfície principal: web local responsiva, acessível via Tailscale.
- Layout: dashboard completo, desktop-first e utilizável no celular.
- Áreas previstas:
  - Visão geral;
  - Câmeras ao vivo;
  - Timeline/DVR;
  - Eventos e tags;
  - OCR;
  - Chat/Gemma;
  - Áudio;
  - Drive;
  - Saúde, modelos e recursos;
  - Configurações/permissões.
- Live preview: prévia econômica e timeline detalhada para alta qualidade.
- Acesso: confiança na identidade da tailnet; não criar exposição pública.
- O Core deve continuar ouvindo em loopback; Tailscale Serve/reverse proxy será a fronteira de rede.

### Áudio

- Alexa:
  - wake word e entrada para comandos/intenções reconhecidas pelo Home Assistant;
  - saída de voz via `Speak`/`Announce` do Home Assistant;
  - sem skill própria na AWS;
  - sem promessa de conversa livre com o Gemma pela Alexa.
- PC/web:
  - conversa livre com o Gemma;
  - push-to-talk via atalho global do Windows;
  - overlay de voz abre ou recebe foco;
  - microfone do PC para entrada;
  - alto-falante do PC para saída.
- Processamento:
  - local-first;
  - benchmark de STT/TTS local antes de habilitar qualquer cloud;
  - cloud TTS/STT somente como fallback configurável, com cache, quota e limite mensal;
  - GPU reservada ao Gemma/VLM, com no máximo um modelo neural residente.
- Default de privacidade: áudio bruto não é persistido; o Core guarda transcript, metadados e referências de evidência. Gravação de áudio bruto será um opt-in futuro separado.

### DVR, Drive e retenção

- Gravação contínua econômica 24/7.
- Clips de eventos relevantes em alta qualidade.
- Upload assíncrono em segmentos concluídos, usando upload resumable e readback.
- O PC mantém apenas buffer temporário até o Drive confirmar o arquivo.
- Retenção:
  - contínuo: 30 dias;
  - eventos relevantes: 90 dias;
  - eventos críticos/protegidos: manual até exclusão explícita.
- Segmentos protegidos por tag crítica nunca podem ser removidos pela rotina automática.
- O Drive é arquivo remoto, não um arquivo vivo que recebe append indefinidamente.

### Importância, sessões e tags

- O Gemma pode descrever uma sessão e propor importância.
- Política determinística + regras da sessão decidem retenção, alerta e proteção.
- “Avise quando o entregador chegar” vira uma `watch session` temporária com:
  - janela de validade;
  - câmera/região;
  - pessoa anônima + veículo + aproximação;
  - opcionalmente pacote;
  - alerta para Alexa e PC;
  - sem afirmar identidade sem Face ID confirmado.
- Face ID é futuro, opt-in, com cadastro/consentimento local.
- Tags automáticas e humanas coexistem; correção humana não apaga a observação original.
- Exemplos esperados:

```text
carro: cor=prata
pessoa: pose=sentada
cadeira: presente=true
relação: pessoa próxima/cadeira
```

### Ações futuras

- A primeira interface é read-only.
- Ações serão planejadas desde já, mas somente como:

```text
proposed
  -> confirmed_by_user
  -> executing
  -> succeeded | failed
```

- Alexa não executa ação crítica por uma inferência visual isolada.
- Portão, fechadura, alarme e ações físicas terão uma política adicional quando essa fase for autorizada.

---

## 2. Evidências e limites atuais

### Código atual

- `src/server.ts`
  - compõe PostgreSQL/in-memory stores;
  - reidrata World State;
  - inicializa snapshot/recording retention;
  - inicia Fastify em `127.0.0.1` por padrão.
- `src/app.ts`
  - possui `/health`, `/conversation`, `/events`, `/audit`, `/recordings`, `/timeline` e saúde de câmera;
  - não existe frontend nem rota de áudio hoje.
- `src/orchestrator.ts`
  - usa Gemma para texto/tool calling;
  - limita a três rodadas de ferramentas;
  - aplica `GroundingGuard`;
  - registra auditoria.
- `src/llm/ollama-gateway.ts`
  - gateway local `/api/chat`;
  - modelo padrão `gemma-hermes:latest`;
  - `num_ctx=8192`, temperatura `0.2`.
- `src/tools/tool-registry.ts`
  - tools read-only existentes para estado, eventos, objetos, OCR, gravações, timeline, snapshot e status do detector;
  - `PolicyEngine` e auditoria já são a fronteira determinística.
- `src/vision/`
  - YOLO11n/ONNX para pessoas/objetos;
  - RapidOCR sob demanda;
  - status/supervisor do detector.
- `src/recordings/`
  - FFmpeg segmentado;
  - catálogo PostgreSQL;
  - timeline;
  - retenção;
  - upload/readback Drive.
- Dependências atuais no `package.json`: Fastify, ONNX Runtime, `pg`, Zod, TypeScript, Vitest e `tsx`; não há dependência frontend, STT ou TTS.

### Ambiente observado

- Tailscale está instalado e ativo no PC Windows.
- FFmpeg e Ollama estão disponíveis.
- Home Assistant está configurado para o perfil, mas a consulta automática de entidades/serviços retornou erro HTTP 530 durante esta auditoria; os entity IDs Alexa e os destinos de áudio ainda precisam ser descobertos read-only antes da implementação do adaptador.
- Não há autostart, supervisor, DVR contínuo ou modelo residente na GPU como parte desta etapa.

### Pesquisa externa

- Home Assistant `Alexa Devices` documenta `Speak`, `Announce`, envio de comandos de texto e eventos de última interação; isso sustenta Alexa como saída e canal de comandos HA, não como captura arbitrária de áudio local.
  - https://www.home-assistant.io/integrations/alexa_devices/
- Home Assistant `Conversation` permite microfone no frontend suportado e `conversation.process` para texto transcrito.
  - https://www.home-assistant.io/integrations/conversation/
- Home Assistant `Amazon Alexa` separa Smart Home Skill de Custom Alexa Skill; conversa livre personalizada exigiria a fronteira AWS que o usuário decidiu não criar.
  - https://www.home-assistant.io/integrations/alexa/
- Home Assistant TTS expõe `tts.speak` e formatos preferenciais para media players.
  - https://www.home-assistant.io/integrations/tts/
- Piper lista vozes `pt_BR`, incluindo `edresson` low e `jeff` medium; ambas devem ser ouvidas e medidas antes de serem promovidas.
  - https://github.com/rhasspy/piper/blob/master/VOICES.md
- Azure Speech publica franquia F0 para TTS neural e STT; Google Cloud publica franquias para TTS. Valores, billing e disponibilidade regional devem ser revalidados no benchmark e nunca codificados como garantia permanente.
  - https://azure.microsoft.com/en-us/pricing/details/speech
  - https://cloud.google.com/text-to-speech
- Google Drive recomenda upload resumable para arquivos grandes ou conexões sujeitas a interrupção; a API possui quotas e limites de upload/storage.
  - https://developers.google.com/drive/api/guides/manage-uploads
  - https://developers.google.com/drive/api/guides/limits

### Cálculo de capacidade já observado

O segmento transcodificado de teste consumiu aproximadamente 4,28 MB em 3,138 s. Isso equivale, nesse bitrate de teste, a aproximadamente 117,8 GB/dia, 3,30 TB em 28 dias ou 3,53 TB em 30 dias para um único stream. O perfil econômico precisa ser medido antes de habilitar 24/7; o arquivo de eventos deve reservar capacidade no Drive.

---

## 3. Arquitetura alvo

```text
                         Tailscale tailnet
                               │
                     Tailscale Serve / proxy
                               │
                 ┌─────────────▼─────────────┐
                 │ Jarvis Web UI              │
                 │ dashboard + overlay áudio │
                 └──────┬──────────────┬──────┘
                        │              │
              HTTP/WebSocket       áudio PC
                        │              │
                 ┌──────▼──────────────▼──────┐
                 │ Jarvis Core                 │
                 │ Fastify + policy + audit   │
                 └──────┬──────────────┬───────┘
                        │              │
                 ┌──────▼──────┐ ┌────▼──────────┐
                 │ Gemma/Ollama│ │ Audio Router  │
                 │ texto/VLM   │ │ STT/TTS       │
                 └─────────────┘ └────┬─────┬────┘
                                      │     │
                              local CPU    │ HA Alexa
                                      │     │
                                PC mic/box  Alexa

 RTSP -> FFmpeg -> local staging -> Drive resumable archive
             │          │
             │          └-> PostgreSQL catalog
             └-> sampled frames -> YOLO/OCR -> tags/events
```

### Contratos centrais novos

Criar contratos neutros antes dos adapters:

- `AudioSession`
  - `id`, `source`, `startedAt`, `endedAt`, `transcript`, `response`, `ttsTarget`, `status`, `error`.
- `SttProvider`
  - entrada: PCM/WAV bounded;
  - saída: transcript, language, confidence, latency, provider, model.
- `TtsProvider`
  - entrada: texto, locale, voice, rate;
  - saída: áudio, duration, provider, model, cache key, latency.
- `AudioOutputAdapter`
  - `pc`
  - `home_assistant_alexa`
- `ObservationTag`
  - `id`, `evidenceEventId`, `recordingId`, `frameRef`, `namespace`, `key`, `value`, `confidence`, `source`, `status`, `createdAt`, `reviewedAt`.
- `ImportanceProposal`
  - `eventId`, `level`, `reason`, `evidenceIds`, `model`, `policyDecision`, `retentionTier`.
- `WatchSession`
  - `id`, `owner`, `createdAt`, `expiresAt`, `camera`, `region`, `predicates`, `notificationTargets`, `status`, `matches`.
- `RecordingArchiveState`
  - `local`, `uploading`, `verified`, `failed`, `protected`, `deleted`.

---

## 4. Fases de implementação

## Fase A — fundação da interface e contratos

### Tarefa A1: Criar o shell web

**Files:**
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/styles/tokens.css`
- Create: `web/src/styles/app.css`
- Modify: `package.json`
- Modify: `vite.config.ts`

**Implementação:**

- React + Vite + TypeScript.
- Layout desktop-first responsivo.
- Sidebar recolhível.
- Header com saúde, câmera selecionada, áudio e modelo ativo.
- Tema escuro baseado em tokens.
- Nenhum segredo no bundle.

**Teste primeiro:**

- Create: `web/src/App.test.tsx`
- Verificar que a navegação renderiza todas as áreas sem chamadas de rede.

**Verificação:**

```bash
npm test -- web/src/App.test.tsx
npm run build:web
```

Aceite: shell renderiza em desktop e viewport estreito, sem quebrar quando API está indisponível.

### Tarefa A2: Criar cliente HTTP tipado

**Files:**
- Create: `web/src/api/client.ts`
- Create: `web/src/api/types.ts`
- Create: `web/src/api/client.test.ts`

**Implementação:**

- Cliente com timeout, abort controller e tratamento de erro.
- Tipos para health, event, recording, timeline, tag e audio session.
- Nunca retornar payload de base64 para listas.
- Preservar timestamps ISO e referências de evidência.

**Verificação:**

```bash
npm test -- web/src/api/client.test.ts
```

### Tarefa A3: Integrar assets estáticos ao Fastify

**Files:**
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Create: `src/web/static-serving.ts`
- Test: `tests/static-serving.test.ts`

**Implementação:**

- Servir `web/dist` somente depois de build.
- Em desenvolvimento, permitir Vite dev server separado, sem misturar com o Core de produção.
- Manter `/health`, `/conversation` e APIs existentes compatíveis.
- Rejeitar traversal de arquivos.

**Verificação:**

```bash
npm run build:web
npm run build
npm test -- tests/static-serving.test.ts
```

---

## Fase B — API e dashboard operacional

### Tarefa B1: Health e visão geral

**Files:**
- Create: `src/health/system-health.ts`
- Modify: `src/app.ts`
- Create: `web/src/pages/OverviewPage.tsx`
- Create: `web/src/components/HealthCard.tsx`
- Test: `tests/system-health.test.ts`

**Endpoint:**

```text
GET /system/health
```

Retornar somente metadata segura:

- Core;
- PostgreSQL;
- Ollama reachability e modelo configurado, sem prompt/segredo;
- detector status;
- DVR scheduler;
- Drive backup state;
- Tailscale access hint, sem chaves/IPs sensíveis.

### Tarefa B2: Câmera e prévia ao vivo

**Files:**
- Modify: `src/app.ts`
- Create: `src/cameras/camera-preview-service.ts`
- Create: `web/src/pages/CamerasPage.tsx`
- Create: `web/src/components/CameraPreview.tsx`
- Test: `tests/camera-preview.test.ts`

**Implementação em duas camadas:**

1. MVP robusto: snapshot JPEG atual com polling de 1–2 s e timestamp visível.
2. Extensão: preview HLS/LL-HLS econômico gerado por FFmpeg, com fallback automático para snapshot quando stream não estiver pronto.

Não enviar vídeo ao Gemma por padrão. O Gemma recebe snapshot somente quando chama a tool visual.

**Aceite:**

- preview não bloqueia a timeline;
- câmera indisponível aparece como estado, não como erro fatal;
- uma câmera não derruba o dashboard inteiro;
- nenhuma URL RTSP é devolvida ao navegador.

### Tarefa B3: Timeline e reprodução

**Files:**
- Modify: `src/timeline/timeline-service.ts`
- Modify: `src/app.ts`
- Create: `web/src/pages/TimelinePage.tsx`
- Create: `web/src/components/TimelineFilters.tsx`
- Create: `web/src/components/TimelineRow.tsx`
- Test: `tests/timeline-api.test.ts`
- Test: `web/src/components/TimelineRow.test.tsx`

**Filtros:**

- câmera;
- período;
- tipo de evento;
- classe de objeto;
- texto OCR;
- tag;
- importância;
- protegido/não protegido.

**Comportamento:**

- lazy loading/paginação;
- clip reproduzido por referência de recording autorizada;
- eventos e segmentos aparecem juntos;
- tags mostram fonte e confiança;
- resposta da timeline permanece compacta para o Gemma.

### Tarefa B4: Eventos, OCR e tags

**Files:**
- Create: `src/tags/tag-schema.ts`
- Create: `src/tags/tag-store.ts`
- Create: `src/tags/tag-service.ts`
- Create: `src/tags/tag-query.ts`
- Modify: `src/app.ts`
- Create: `web/src/pages/TagsPage.tsx`
- Create: `web/src/components/TagEditor.tsx`
- Test: `tests/tag-service.test.ts`
- Test: `tests/tag-api.test.ts`

**Endpoints read-only iniciais:**

```text
GET /tags
GET /tags/:id
GET /evidence/:id
GET /events/:id
```

A edição humana deve ser planejada como evento de revisão, mesmo que o endpoint de escrita permaneça desabilitado na primeira versão. Não alterar a observação original; criar `human_reviewed` ou `human_override` relacionado.

**Exemplo de resultado:**

```json
{
  "namespace": "car",
  "key": "color",
  "value": "prata",
  "source": "model",
  "confidence": 0.83,
  "status": "observed"
}
```

---

## Fase C — Gemma e ferramentas da interface

### Tarefa C1: Tools read-only da interface

**Files:**
- Modify: `src/tools/tool-registry.ts`
- Create: `src/tools/tag-tools.ts`
- Create: `src/tools/watch-session-tools.ts`
- Create: `src/tools/importance-tools.ts`
- Test: `tests/tools/tag-tools.test.ts`
- Test: `tests/tools/watch-session-tools.test.ts`

Adicionar somente quando os stores existirem:

- `search_tags`
- `get_evidence`
- `search_importance_proposals`
- `get_watch_session`
- `list_audio_sessions`
- `get_system_health`

Todas continuam `risk: read`.

### Tarefa C2: Proposta de importância

**Files:**
- Create: `src/importance/importance-proposal.ts`
- Create: `src/importance/importance-policy.ts`
- Modify: `src/orchestrator.ts`
- Test: `tests/importance-policy.test.ts`
- Test: `tests/orchestrator-importance.test.ts`

**Regra:**

- Gemma pode produzir `ImportanceProposal` com justificativa e IDs de evidência.
- A política verifica origem, confiança, tags, watch sessions e estado temporal.
- Nenhum proposal sozinho altera retenção, envia alerta ou executa ação.
- O Core registra a decisão e o motivo.

### Tarefa C3: Watch session de entrega

**Files:**
- Create: `src/watch/watch-session-schema.ts`
- Create: `src/watch/watch-session-store.ts`
- Create: `src/watch/watch-session-matcher.ts`
- Modify: `src/events/schema.ts`
- Modify: `src/app.ts`
- Create: `web/src/components/WatchSessionPanel.tsx`
- Test: `tests/watch-session-matcher.test.ts`
- Test: `tests/watch-session-expiry.test.ts`

**MVP:**

- criar/visualizar sessão internamente, sem endpoint público de escrita ainda;
- predicados: pessoa, veículo, aproximação, câmera, região e validade;
- match gera evento `watch.match.proposed`;
- alerta fica em estado `proposed` até política e confirmação;
- sem Face ID e sem afirmar “é o entregador”.

---

## Fase D — áudio local e roteamento Alexa/PC

### Tarefa D1: Descoberta read-only do Home Assistant

**Files:**
- Create: `src/audio/home-assistant-discovery.ts`
- Create: `scripts/read-only-ha-audio-inventory.ts`
- Create: `tests/audio/home-assistant-discovery.test.ts`

**Procedimento:**

- obter `media_player`, `notify.*_speak`, `notify.*_announce`, Assist/Conversation e possíveis pipelines;
- não chamar serviço de fala durante descoberta;
- não imprimir token, URL privada desnecessária ou conteúdo de notificações;
- salvar apenas IDs e capacidades redigidos em um manifesto local de desenvolvimento;
- se a API continuar retornando 530, registrar bloqueio e pedir acesso/entidade somente quando necessário.

### Tarefa D2: Contratos de STT/TTS

**Files:**
- Create: `src/audio/audio-types.ts`
- Create: `src/audio/stt-provider.ts`
- Create: `src/audio/tts-provider.ts`
- Create: `src/audio/audio-session-store.ts`
- Create: `tests/audio/audio-types.test.ts`

**Regras:**

- todos os providers retornam latency/provider/model/confidence;
- payloads de áudio têm tamanho máximo e timeout;
- transcript sem confiança suficiente fica `uncertain`;
- áudio bruto não persiste no default;
- cada sessão registra `source: pc | alexa | text`.

### Tarefa D3: Spike de STT local

**Files:**
- Create: `spikes/005-local-audio-benchmark/README.md`
- Create: `spikes/005-local-audio-benchmark/fixtures/ptbr-fixtures.json`
- Create: `spikes/005-local-audio-benchmark/run-stt-benchmark.ts`
- Create: `spikes/005-local-audio-benchmark/results/.gitkeep`

**Candidatos:**

- Whisper/Wyoming local em CPU;
- sidecar local compatível com o Core;
- integração HA Assist/Wyoming se a instalação oferecer o pipeline.

**Medições:**

- WER/CER em português brasileiro;
- latência p50/p95;
- consumo RAM/CPU;
- duração máxima suportada;
- ruído e pontuação;
- nenhum modelo de áudio carregado na GPU sem aprovação explícita.

**Aceite:** benchmark reproduzível com fixture sintético + amostras reais controladas, sem persistir conversas pessoais.

### Tarefa D4: Spike de TTS local e fallback cloud

**Files:**
- Create: `spikes/006-tts-ptbr-benchmark/README.md`
- Create: `spikes/006-tts-ptbr-benchmark/run-tts-benchmark.ts`
- Create: `spikes/006-tts-ptbr-benchmark/results/.gitkeep`
- Create: `src/audio/providers/piper-tts-provider.ts`
- Create: `src/audio/providers/cloud-tts-provider.ts`
- Test: `tests/audio/tts-provider.test.ts`

**Ordem:**

1. Piper `pt_BR-edresson-low`;
2. Piper `pt_BR-jeff-medium`;
3. Azure/Google somente com credencial e quota explicitamente habilitadas;
4. Alexa via HA como saída híbrida separada.

**Medições:**

- naturalidade PT-BR, pronúncia e pausas;
- tempo até primeiro áudio;
- duração e tamanho;
- CPU/RAM;
- cache hit/miss;
- custo/quota cloud;
- falha de provider e fallback.

**Regra de GPU:** TTS local deve rodar na CPU primeiro. Se um candidato GPU for avaliado, fazer `ollama ps`/`nvidia-smi`, descarregar o modelo anterior, carregar somente o candidato, medir, descarregar e confirmar lista vazia antes de qualquer modelo seguinte.

### Tarefa D5: Roteador de saída

**Files:**
- Create: `src/audio/audio-router.ts`
- Create: `src/audio/outputs/pc-output.ts`
- Create: `src/audio/outputs/home-assistant-alexa-output.ts`
- Modify: `src/app.ts`
- Test: `tests/audio/audio-router.test.ts`

**Policy:**

```text
source=pc    -> STT -> Core/Gemma -> TTS PC
source=alexa -> HA command/intent -> Core/HA Alexa output
source=text  -> Core/Gemma -> target escolhido na UI
```

- Alexa output usa `notify.send_message`/Speak/Announce somente após descobrir o entity ID real.
- Toda resposta identifica o destino e registra latência.
- Fallback cloud não deve acontecer silenciosamente: registrar provider, motivo e quota.
- Sem ação doméstica nessa fase.

### Tarefa D6: Push-to-talk e atalho global Windows

**Files:**
- Create: `src/audio/pc-hotkey.ts`
- Create: `src/audio/pc-capture.ts`
- Create: `scripts/run-voice-hotkey.ts`
- Create: `web/src/components/VoiceOverlay.tsx`
- Create: `web/src/hooks/useVoiceSession.ts`
- Test: `tests/audio/pc-hotkey.test.ts`
- Test: `tests/audio/voice-session.test.ts`

**Design:**

- hotkey padrão candidato: `Ctrl+Alt+J`, configurável;
- pressionar inicia estado `recording`; soltar envia áudio bounded;
- overlay mostra fonte, duração, VU/estado, transcript parcial/final, resposta e destino TTS;
- o processo auxiliar não deve habilitar autostart por padrão;
- se captura global exigir módulo nativo, executar spike isolado antes de adicionar dependência permanente;
- fallback seguro: botão de push-to-talk dentro da página enquanto o helper não estiver aprovado.

**Aceite:** atalho não grava quando o Jarvis está desabilitado, não deixa microfone aberto e encerra a sessão em timeout.

---

## Fase E — DVR 24/7 econômico e Drive

### Tarefa E1: Perfis de gravação

**Files:**
- Modify: `src/recordings/ffmpeg-recorder.ts`
- Create: `src/recordings/recording-profile.ts`
- Create: `tests/recordings/recording-profile.test.ts`

Criar profiles explícitos:

- `continuous-economic`;
- `event-high-quality`;
- `manual-export`.

Cada profile declara resolução, FPS, codec, bitrate/preset, áudio, duração do segmento e limite de bytes. Não hardcodar o bitrate atual de teste como se fosse econômico.

### Tarefa E2: Fila de upload e staging local

**Files:**
- Create: `src/recordings/recording-upload-queue.ts`
- Modify: `src/recordings/recording-drive-archive.ts`
- Modify: `src/recordings/recording-store.ts`
- Create: `src/recordings/recording-staging-policy.ts`
- Test: `tests/recordings/upload-queue.test.ts`
- Test: `tests/recordings/staging-policy.test.ts`

**Invariantes:**

- nunca apagar local antes de readback remoto;
- retry com exponential backoff;
- fila idempotente por recording ID/checksum;
- limite local de staging configurável;
- quando a fila travar, alertar e preservar a evidência mais recente;
- upload resumable para arquivos grandes;
- status explícito `local/uploading/verified/failed/protected/deleted`.

### Tarefa E3: Retenção de 30/90 dias

**Files:**
- Modify: `src/recordings/recording-retention.ts`
- Modify: `src/recordings/recording-retention-scheduler.ts`
- Create: `src/recordings/retention-budget.ts`
- Test: `tests/recordings/recording-retention.test.ts`
- Test: `tests/recordings/retention-budget.test.ts`

**Política:**

- continuous: 30 dias;
- event: 90 dias;
- critical/protected: manual;
- excluir oldest-first apenas depois de `backupStatus=verified`;
- nunca exceder budget configurado sem entrar em `degraded` e pedir decisão;
- listar candidatos e motivo antes de qualquer exclusão;
- default `dry-run` até o usuário autorizar o scheduler de upload/deleção.

### Tarefa E4: Clips de alta qualidade por evento

**Files:**
- Create: `src/recordings/event-clip-builder.ts`
- Create: `src/recordings/prepost-roll-buffer.ts`
- Modify: `src/recordings/recording-indexer.ts`
- Test: `tests/recordings/event-clip-builder.test.ts`

- ligar `object.observed`, `ocr.observation`, `watch.match.proposed` e `importance` a clips;
- usar pre-roll/post-roll quando disponível;
- não gerar clip duplicado para cada frame;
- usar janela/ID determinístico;
- high-quality clip preservado por tags relevantes.

---

## Fase F — tags semânticas, importância e revisão humana

### Tarefa F1: Extrair atributos de objetos

**Files:**
- Modify: `src/vision/object-detection-worker.ts`
- Create: `src/vision/attribute-observation.ts`
- Modify: `src/events/ai-observation-schema.ts`
- Test: `tests/vision/attribute-observation.test.ts`

Separar:

- classe (`car`, `person`, `chair`);
- atributos (`color`, `pose`, `size`, `occluded`);
- relações (`near`, `inside`, `sitting_on`, `approaching`);
- confiança e origem.

O YOLO sozinho não pode inventar cor/pose/relação. Atributos adicionais devem vir de uma etapa visual explícita ou ficar `unknown`.

### Tarefa F2: Revisão humana read-only primeiro

**Files:**
- Create: `src/reviews/observation-review.ts`
- Create: `web/src/pages/ReviewPage.tsx`
- Create: `web/src/components/EvidenceReviewCard.tsx`
- Test: `tests/reviews/observation-review.test.ts`

Na primeira versão:

- mostrar botões e estados de revisão sem executar escrita;
- preparar payload de review;
- preservar observação automática;
- exigir confirmação separada para persistir override.

### Tarefa F3: Face ID futuro

**Files reservados, não implementar nesta fase:**

- `src/identity/face-enrollment.ts`
- `src/identity/face-matcher.ts`
- `src/identity/identity-policy.ts`
- `web/src/pages/IdentityPage.tsx`

Pré-condições:

- consentimento explícito;
- cadastro local;
- política de retenção biométrica;
- distinção `identity_candidate`/`identity_confirmed`;
- nenhum fallback para “nome provável”;
- nenhum envio cloud por padrão.

---

## Fase G — segurança de acesso e camada de ações futuras

### Tarefa G1: Tailscale-only sem expor o Core

**Files:**
- Create: `docs/tailscale-serving.md`
- Create: `scripts/read-only-tailscale-check.ts`
- Modify: `.env.example`
- Test: `tests/network/bind-policy.test.ts`

**Política:**

- Core continua em `127.0.0.1`;
- Tailscale Serve aponta para o serviço local depois de aprovação operacional;
- não colocar RTSP, token, OAuth ou senha em HTML/log;
- não abrir porta pública;
- health page não revela secrets, URLs autenticadas ou conteúdo pessoal.

### Tarefa G2: Modelo de ações propostas

**Files:**
- Create: `src/actions/action-proposal-schema.ts`
- Create: `src/actions/action-proposal-store.ts`
- Create: `src/actions/action-policy.ts`
- Modify: `src/tools/tool-registry.ts`
- Create: `web/src/components/ActionProposalCard.tsx`
- Test: `tests/actions/action-policy.test.ts`

A primeira versão registra propostas e confirmações simuladas, sem serviço físico.

- `read` continua automático;
- `propose` pode aparecer no Gemma/UI;
- `write`/físico permanece negado;
- cada futura ação terá alvo, motivo, evidência, expiração, confirmação e readback.

---

## 5. Navegação proposta

```text
/                  Overview
/cameras            Live preview + camera health
/timeline           Recordings + events + clips
/events             Event stream and importance
/tags               Structured tags and filters
/ocr                OCR search and evidence
/chat               Gemma conversation + tool trace
/audio              PC push-to-talk + provider state
/drive              Archive queue, verified items, quota budget
/system             Core, Postgres, Ollama, detector, FFmpeg, GPU
/settings           Read-only configuration and future permissions
/review             Human review queue
```

### Overview cards

- câmera/RTSP health;
- gravação atual e fila Drive;
- espaço local temporário;
- retenção contínua/eventos;
- Gemma provider/model;
- GPU/VRAM and exclusivity state;
- detector/OCR health;
- sessões de observação ativas;
- últimas evidências importantes.

### UX de investigação

Um clique em um evento deve abrir:

```text
evento
  -> frame/evidence
  -> recording segment
  -> high-quality clip
  -> tags
  -> OCR
  -> importance proposal
  -> watch session match
  -> audit trace
```

---

## 6. Testes e critérios de aceite globais

### Testes automatizados

- schemas Zod para áudio, tags, watch sessions, importance e retention;
- cliente web com API indisponível;
- paginação e filtros da timeline;
- segurança contra path traversal em clips;
- idempotência de tags e uploads;
- retry/backoff Drive;
- retenção não remove protected/critical;
- Core não executa proposal;
- atalho encerra microfone em timeout;
- fallback cloud só quando explicitamente habilitado;
- nenhum teste carrega dois modelos na GPU.

### Smoke tests bounded

1. Abrir dashboard via localhost.
2. Abrir o mesmo dashboard por Tailscale Serve autorizado.
3. Ver preview econômico da câmera.
4. Consultar timeline e reproduzir um clip real.
5. Fazer uma sessão de push-to-talk curta.
6. Transcrever fixture PT-BR.
7. Gerar TTS local.
8. Exercitar fallback com quota simulada, sem cloud real.
9. Consultar Alexa entity descoberta sem executar ação crítica.
10. Gravar um segmento econômico curto.
11. Fazer upload resumable de um segmento de teste.
12. Ler metadata remoto de volta.
13. Simular retenção e provar que o item mais antigo não protegido seria o candidato.
14. Encerrar tudo e confirmar nenhum processo órfão/modelo residente.

### Critérios de release da fase

- UI não depende do Gemma para renderizar ou navegar.
- UI permanece funcional com Ollama desligado.
- Alexa só aparece como disponível após entity/capability real do HA ser descoberta.
- PC voice path tem transcript e resposta reproduzíveis.
- Piper/Whisper ou alternativa local tem resultado aceitável documentado; cloud continua fallback se não houver decisão de promoção.
- continuous 24/7 usa profile econômico medido.
- Drive verifica cada upload antes de remover staging local.
- 30/90 dias são aplicados por metadata, não pelo nome do arquivo.
- Tags preservam origem, confiança e revisão.
- Gemma nunca decide sozinho retenção crítica ou ação física.
- Face ID não entra no runtime desta fase.
- `npm test` e `npm run build` passam integralmente.

---

## 7. Riscos e decisões de contenção

| Risco | Contenção |
|---|---|
| Alexa não expõe conversa livre ao Core sem skill AWS | tratar Alexa como HA command/output e usar PC/web para conversa livre |
| 24/7 no bitrate atual consome ~3,5 TB/30 dias | profile econômico, budget Drive e reserva para eventos |
| falha/interrupção no upload | resumable upload, fila, readback, retry e staging limitado |
| Drive quota/storage muda | monitorar quota, budget, backoff e estado degraded |
| TTS Piper PT-BR não soa bem | benchmark A/B, cloud fallback com limite, Alexa output separado |
| STT CPU lento | medir p50/p95, bounded audio, possível sidecar local; não ocupar GPU sem benchmark |
| hotkey global exige módulo nativo | spike isolado e fallback para botão na web |
| overlay/stream expõe RTSP | browser recebe somente endpoints proxy autorizados |
| Gemma supervaloriza evento | proposta separada de decisão determinística |
| Face ID gera falso positivo/risco de privacidade | opt-in, enrollment, identidade confirmada separada e sem implementação nesta fase |
| OCR de timestamps polui tags | máscara/configuração de região e origem `overlay` separada de texto de cena |
| múltiplos workers ou modelos na GPU | status/lock de exclusividade e verificação com `ollama ps`/`nvidia-smi` |

---

## 8. Ordem recomendada de execução

1. Shell web + API client + static serving.
2. Overview + health + cameras snapshot preview.
3. Timeline + player + tags read-only.
4. Modelagem de tags/importance/watch session.
5. STT local benchmark.
6. TTS local benchmark.
7. Audio router + PC overlay/push-to-talk.
8. Descoberta e adapter Alexa/HA.
9. Recording profiles e economic stream.
10. Upload queue + Drive verification.
11. 30/90-day retention em dry-run.
12. Event high-quality clips.
13. Propostas de ações sem execução.
14. Tailscale Serve operacional, após smoke local.

Não iniciar Fase 8 de Face ID, nem automações físicas, antes dos critérios acima passarem.

---

## 9. Rollback e operação segura

- Cada fase deve ter feature flag desligada por default.
- Nenhum worker contínuo é habilitado automaticamente.
- `JARVIS_AUDIO_ENABLED=false` até provider local passar.
- `JARVIS_CLOUD_TTS_ENABLED=false` e `JARVIS_CLOUD_STT_ENABLED=false` por default.
- `JARVIS_RECORDING_BACKUP_ENABLED=false` até upload/readback e quota serem validados.
- `JARVIS_RECORDING_RETENTION_DRY_RUN=true` por default.
- `JARVIS_ACTIONS_ENABLED=false` permanentemente nesta fase.
- Nenhuma mudança de modelo Gemma sem unload e verificação de exclusividade GPU.
- Em falha de Drive, preservar local dentro do staging budget e alertar; não apagar evidência.
- Em falha de áudio, voltar para texto no chat; não deixar microfone aberto.
- Em falha Alexa/HA, manter PC/web disponível e marcar Alexa como `unavailable`.

---

## 10. Documentação a atualizar durante a implementação

- `JARVIS_AI_MAP.md`
- `JARVIS_AI_MAP.html`
- este plano
- `README.md`
- `docs/audio-architecture.md`
- `docs/web-interface.md`
- `docs/recording-and-drive.md`
- `docs/tagging-and-importance.md`
- `docs/tailscale-serving.md`
- `spikes/005-local-audio-benchmark/README.md`
- `spikes/006-tts-ptbr-benchmark/README.md`

Cada atualização deve separar:

- ativo no runtime;
- benchmark/experimental;
- planejado;
- determinístico/não-IA;
- estado atual de processos e modelos;
- o que não foi verificado.

Não registrar tokens, URLs RTSP autenticadas, áudio pessoal, base64, chaves Tailscale ou conteúdo OCR sensível.

---

## 11. Estado esperado ao final da implementação

```text
Interface: disponível via Tailscale, sem exposição pública
Alexa: comandos HA + Speak/Announce, sem custom AWS skill
PC: push-to-talk global + overlay + conversa livre
STT/TTS: local-first, fallback cloud controlado
GPU: no máximo um modelo residente
DVR: economic 24/7 + event clips high quality
PC disk: somente staging temporário até Drive verified
Drive: continuous 30d + events 90d + critical manual
Tags: classe + atributos + relações + origem + confiança + revisão
Gemma: descrição/proposta, nunca autoridade final
Ações: propostas visíveis, confirmação explícita, execução ainda bloqueada
Face ID: planejado, opt-in, não ativo
```

## 12. Estado verificado da execução

Implementado e verificado:

- Dashboard React/Vite servido pelo Core em `/ui/`, com overview, câmeras, timeline/DVR, eventos, tags, OCR, chat, áudio, Drive, sistema, ações e configurações.
- Stream ao vivo oficial em `/cameras/:camera/live-video`: FFmpeg contínuo, HEVC RTSP convertido para H.264/MPEG-TS de baixa latência e player `mpegts.js` na dashboard; `/live` MJPEG fica como compatibilidade legada.
- Core preso a `127.0.0.1:3000` e exposto pela configuração Tailscale Serve em modo `tailnet only`.
- Tags derivadas de eventos de objetos/OCR com origem, confiança, status e evidência preservada.
- Pipeline PC de áudio por push-to-talk: Faster-Whisper CPU → Gemma → Piper CPU; o STT usa `medium` em worker residente, VAD com padding e sessão sem áudio bruto persistida no PostgreSQL.
- A captura web solicita mono, `16 kHz`/`16-bit` ideais, cancelamento de eco, supressão de ruído e ganho automático; quando disponível, prioriza o microfone físico Fifine sem persistir `deviceId`.
- Voz `pt_BR-jeff-medium` instalada e exercitada; fallback Azure possui adapter, cache e quota, mas permanece desligado.
- Adapter Alexa/Home Assistant pronto; entidades observadas: `media_player.sala_echo_dot`, `notify.echo_dot_speak` e `notify.echo_dot_announce`. Nenhuma chamada de fala foi executada.
- Perfis DVR econômico/evento, fila de upload idempotente, readback do Drive e estados `verified`/`remote_deleted` implementados.
- Retenção codificada como contínuo 30 dias, eventos 90 dias e `protected` manual; trash é padrão e exclusão permanente exige flag separada.
- Propostas de importância, watch sessions e ações ficam separadas da decisão determinística; endpoints de execução continuam ausentes.
- Suíte final com `.env`: 93 arquivos e 229 testes passando, 1 teste PostgreSQL pulado por ausência do ambiente; build TypeScript + Vite passando.
- `/api/ps` confirmou apenas `gemma-hermes:latest` residente durante a validação.

Limitações observadas:

- O RTSP da câmera `front` inicialmente não respondeu porque o `.env` apontava para o destino anterior; após a atualização do IP no `.env` e reinício manual do Core, health, MJPEG legado e vídeo contínuo foram validados por localhost e Tailscale. O FFmpeg do vídeo é criado somente por conexão e termina quando o cliente fecha.
- O frame RTSP real é um mosaico `1920×2160` com dois painéis horizontais empilhados. A UI usa `contain` + proporção dinâmica para não cortar o enquadramento; o vídeo oficial H.264/MPEG-TS mantém o mosaico e a validação visual confirmou os dois painéis e timestamps completos.
- Upload/deleção de arquivos reais do Drive não foram disparados nesta rodada; foram verificados com runners controlados e o dry-run real encontrou 13 segmentos, zero candidatos, zero uploads e zero deleções.
- O Core de validação foi iniciado manualmente com áudio local habilitado; nenhum autostart foi criado.

### 12.1 Aceitação humana pelo dashboard (2026-09-05)

Percurso realizado na UI publicada por `https://pc.tail14bdd9.ts.net/ui/`, usando as rotas visíveis do dashboard:

- **Visão geral — OK:** health global `operacional`; Core `ok`; Gemma, PostgreSQL, áudio local, Tailscale-only, loopback e guardrails visíveis.
- **Timeline/DVR — OK:** lista real de eventos, snapshots, detecções, OCR e segmentos; botão `Atualizar` exercitado.
- **Eventos — OK:** 21 eventos carregados, incluindo `person.detected`, `vision.observation`, `ocr.observation` e `camera.snapshot`.
- **Tags — OK:** 8 tags carregadas com estado `confirmed`/`observed`, origem, confiança e câmera.
- **OCR — OK:** 5 tags `ocr.text` carregadas com origem e confiança.
- **Drive — OK:** 13 segmentos no catálogo, item `verified` com link remoto, retenção 30/90 e staging temporário visíveis.
- **Sistema — OK:** status global `ok`; Ollama, GPU/VRAM e processos renderizados; `ffmpeg.exe: 0` quando nenhum viewer está aberto (um processo transitório é esperado enquanto o vídeo ao vivo está aberto).
- **Ações — OK/read-only:** zero propostas pendentes; confirmação/execução física explicitamente bloqueadas.
- **Configurações — OK/read-only:** modelo, detector CPU, exclusividade de GPU, cloud desligado, Face ID opt-in e ações físicas bloqueadas visíveis.
- **Câmeras — OK:** com o destino RTSP atual do `.env`, a UI mostrou `front · ok`, `Snapshot disponível` e vídeo web `ao vivo · H.264/MPEG-TS`; o health é concluído antes de abrir o `<video>`, o endpoint contínuo respondeu `HTTP 200`/`video/mp2t` com pacotes MPEG-TS e a validação visual anterior confirmou os dois painéis do mosaico sem crop/deformação.
- **Chat/Gemma — OK:** no navegador isolado, o campo foi preenchido, Enviar habilitou e a resposta `OK.` foi renderizada pelo Gemma local.
- **Áudio — OK operacional:** o seletor exibiu os dispositivos e passou a priorizar o Fifine físico; push-to-talk solicita captura mono com ganho/supressão de ruído, a sessão ponta a ponta terminou `completed` com STT `medium` em CPU, o worker ficou residente entre sessões e o TTS continuou `piper` com `pt_BR-jeff-medium`. O benchmark controlado elevou a confiança da referência de cerca de `0,648` (`base`) para `0,745` (`medium`); a captura humana também retornou sessão `completed` com confiança `0,813`.
- A navegação foi endurecida com links HTML nativos e hash (`#overview`, `#events`, etc.), permitindo abrir/recarregar cada aba diretamente sem depender do estado efêmero do React.

A aceitação humana das funções presentes na dashboard foi concluída com status operacional OK. Upload/deleção real no Drive, anúncio Alexa e ações físicas continuam deliberadamente opt-in/bloqueados e não fazem parte de uma aceitação que exigiria side effects.

**Execução concluída até o limite seguro verificável; pendências ambientais e ações externas permanecem explicitamente bloqueadas.**
