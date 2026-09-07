# Jarvis AI + DVR — Plano de Evolução

> **Para Hermes:** executar este plano tarefa por tarefa, preservando a separação entre modelos de IA, Core determinístico, mídia e ações físicas.

**Goal:** evoluir o Jarvis Core de conversa + detecção de pessoas para uma plataforma local de percepção, busca fundamentada e DVR, com OCR, detecção de objetos, histórico de gravações e arquivamento verificável no Google Drive.

**Architecture:** o Core continua sendo a autoridade de eventos, evidências, memória, políticas e auditoria. Os modelos são workers substituíveis: Gemma via Ollama para linguagem/VLM sob demanda, ONNX para percepção rápida e um worker de OCR escolhido por benchmark. O DVR fica em um subsistema de mídia independente da IA; a IA indexa a mídia, mas não controla diretamente gravação, portão, sirene ou qualquer ação crítica.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Zod, PostgreSQL, FFmpeg/RTSP UDP, `onnxruntime-node`, Ollama/Gemma local, Google Drive OAuth do perfil Hermes `jarvis`. Python poderá ser usado somente em spikes/workers de visão quando um benchmark justificar.

---

## 1. Estado atual confirmado

O mapa técnico atual está em:

- `C:\Users\davi\jarvis\JARVIS_AI_MAP.md`
- `C:\Users\davi\jarvis\JARVIS_AI_MAP.html`

### IA ativa

1. **Gemma via Ollama**
   - Gateway: `src/llm/ollama-gateway.ts`.
   - Modelo padrão: `gemma-hermes:latest`.
   - Endpoint local: `/api/chat`.
   - O Core envia `num_ctx=8192`, `temperature=0.2` e `stream=false`.
   - Atua como LLM, tool caller e VLM quando recebe um snapshot.
   - O fluxo de imagem passa por `get_camera_snapshot`; o Core guarda referência/metadados, não base64 bruto no evento.

2. **YOLO11n via ONNX Runtime**
   - Implementação: `src/vision/onnx-person-detector.ts`.
   - Worker/CLI: `src/vision/run-person-detector.ts`.
   - Modelo: `spikes/001-detector-benchmark/models/yolo11n.onnx`.
   - Provider atual: `CPUExecutionProvider`.
   - Entrada padrão: `640×640`; limiar `0.35`; NMS `0.45`.
   - Confirmação temporal: 2 detecções em até 5 segundos.
   - Não faz identidade nem chama o Gemma.

### Controle que não é IA

`ToolRegistry`, `PolicyEngine`, `GroundingGuard`, `WorldStateProjection`, memória episódica/semântica, PostgreSQL, audit log, confirmação temporal, publicação HTTP e Telegram são determinísticos.

As tools expostas ao Gemma são atualmente read-only:

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

### Mídia existente

- RTSP direto via FFmpeg, UDP por exigência da câmera.
- Stream observado: vídeo HEVC `1920×2160` a `15 FPS` e áudio PCM; os timestamps de origem não permitem `stream copy` confiável no muxer.
- Snapshots locais em `data/snapshots`.
- RapidOCR/ONNX instalado em `tools/ocr/.venv` para OCR sob demanda.
- Gravações locais em `data/recordings`, com segmentos H.264/AAC a 5 FPS, catálogo PostgreSQL e endpoint read-only de clip.
- Retenção local de snapshots e upload ao Google Drive já possuem adapter, confirmação de metadata e proteção contra remoção antes do backup; um segmento DVR real também foi arquivado e verificado.
- O autostart do detector foi revertido; não há inicialização automática instalada.

---

## 2. Objetivos da evolução

### Prioridade alta

1. Generalizar percepção para objetos além de pessoa.
2. Adicionar OCR acionado por evidência, sem OCR contínuo indiscriminado.
3. Expor busca de observações e mídia ao Gemma por tools estritamente read-only.
4. Criar gravação local segmentada e catálogo pesquisável.
5. Vincular eventos, snapshots, OCR, objetos e clips de gravação por evidência.
6. Generalizar o backup atual de snapshots para mídia, mantendo readback no Drive.

### Não objetivos desta evolução

- Reconhecimento facial ou biometria.
- ReID/identidade persistente.
- Abertura de portão, sirene, fechadura ou modo defesa.
- Cloud como dependência de segurança.
- Fine-tuning automático.
- Substituir o Core por Frigate sem benchmark e justificativa operacional.
- Enviar vídeo contínuo ao Gemma.

---

## 3. Arquitetura alvo

```text
                         ┌─────────────────────────────┐
                         │ Gemma / Ollama local        │
                         │ LLM + VLM sob demanda      │
                         └──────────────┬──────────────┘
                                        │ tool calls read-only
                                        ▼
┌──────────────┐   ┌─────────────────────────────────────────────┐
│ Usuário/API  │──▶│ Jarvis Core                                 │
└──────────────┘   │ políticas • evidência • eventos • auditoria │
                   │ World State • memória • busca               │
                   └───────┬──────────────┬──────────────┬────────┘
                           │              │              │
                           ▼              ▼              ▼
                   Object worker    OCR worker      Media catalog
                   YOLO/ONNX CPU    snapshot/frame  recordings + DB
                           │              │              │
                           └──────┬───────┴──────┬───────┘
                                  ▼              ▼
                            PostgreSQL       FFmpeg/RTSP
                                  │              │
                                  └──────┬───────┘
                                         ▼
                              Google Drive archive
                              upload → readback → retain/delete
```

### Regra estrutural

- **Gemma interpreta e consulta.**
- **Workers percebem.**
- **DVR grava e cataloga.**
- **Core valida, persiste, relaciona e audita.**
- **Policy Engine continua bloqueando ações críticas.**

---

## 4. Fase A — Contratos comuns de percepção e mídia

**Objetivo:** criar um formato único de evidência antes de adicionar modelos.

### Tarefa A1 — Definir observação de objeto

**Arquivos:**

- Modificar: `src/events/schema.ts`
- Testar: `tests/events-schema.test.ts` ou teste existente equivalente
- Possível migração: `infrastructure/postgres/002_ai_media.sql`

**Contrato proposto:**

- `object.observed` para observação de classe genérica.
- `object.left` somente quando houver uma fonte confiável de transição.
- Campos: câmera, classe, confiança, caixa, modelo, provider, timestamp e `evidenceEventId`.
- Identidade permanece ausente ou `unknown`.
- Nenhuma imagem base64 no evento.

### Tarefa A2 — Definir observação OCR

**Contrato proposto:**

- `ocr.observation`.
- Texto bruto opcional e texto normalizado para busca.
- Confiança, idioma, bounding box, modelo/provider, câmera, `imageRef` e `evidenceEventId`.
- Política de privacidade para textos sensíveis, placas e documentos.
- O OCR não deve ser enviado automaticamente ao Gemma em todas as capturas; somente quando a pergunta ou política solicitar.

### Tarefa A3 — Definir catálogo de gravações

Criar tabelas/entidades para:

- `recordings`: câmera, início, fim, duração, codec, resolução, áudio, bytes, status e origem.
- `recording_segments`: caminho local, início/fim, checksum, tamanho e estado de backup.
- `media_evidence`: relação entre snapshot, frame OCR, detecção e segmento.

Estados mínimos de mídia:

```text
recording → indexed → queued_for_backup → uploaded → verified → retained/deleted
                                      └────── failed/retryable
```

**Aceitação:** schemas Zod, migração reversível, testes de validação e nenhum segredo RTSP persistido.

---

## 5. Fase B — Detecção de objetos

**Objetivo:** sair de um worker especializado em pessoa para uma camada de percepção extensível, mantendo pessoa como caminho compatível.

### Tarefa B1 — Fazer spike de modelos e classes

**Diretório:** `spikes/002-object-detector-benchmark/`

Comparar no dataset definitivo e no conjunto noturno:

- YOLO11n atual como baseline de pessoa.
- Um modelo ONNX com classes adicionais compatíveis com CPU.
- Opcionalmente o modelo YOLOv9/CUDA já testado, sem adicioná-lo ao runtime.

Classes candidatas, somente se o modelo realmente as suportar:

- pessoa;
- carro;
- moto;
- bicicleta;
- animal;
- pacote/objeto deixado.

**Não escolher pelo nome do modelo.** Medir recall, falsos positivos, latência, tamanho e comportamento no mosaico completo.

### Tarefa B2 — Extrair contrato `ObjectDetector`

**Arquivos prováveis:**

- Criar: `src/vision/object-detector.ts`
- Modificar: `src/vision/onnx-person-detector.ts`
- Testar: `tests/object-detector.test.ts`
- Preservar: `PersonDetectionWorker` como adapter compatível

O contrato deve receber JPEG e retornar observações estruturadas com:

- classe;
- confiança;
- caixa;
- modelo/provider;
- latência;
- timestamp/evidência fornecidos pelo worker.

O detector não terá permissões de escrita física. A única saída externa continuará sendo evento no Core, e publicação continuará opt-in.

### Tarefa B3 — Calibrar por classe

- Manter limiar separado por classe se a medição justificar.
- Manter ROI desativada até uma avaliação específica provar que não esconde pessoas.
- Manter confirmação temporal para pessoas e definir regra independente para objetos estáticos.
- Criar fixtures de carros, motos, plantas, sombras e portas abertas como hard negatives.

**Aceitação:** avaliação offline reproduzível, sem alterar threshold de produção automaticamente.

---

## 6. Fase C — OCR local sob demanda

**Objetivo:** reconhecer texto em evidências selecionadas sem transformar cada frame em uma chamada pesada.

### Tarefa C1 — Spike de engine OCR

**Diretório:** `spikes/003-ocr-benchmark/`

Avaliar somente engines que possam rodar localmente:

- Tesseract/CLI, se a instalação atual permitir;
- RapidOCR/ONNX;
- PaddleOCR, somente se o custo de dependências e CPU for aceitável.

Medir:

- texto correto em placas/etiquetas/documentos de teste autorizados;
- confiança e bounding boxes;
- latência por snapshot;
- memória/CPU;
- suporte a português;
- necessidade de pré-processamento e recorte.

Não instalar um stack OCR permanente antes desse benchmark.

### Tarefa C2 — Implementar `OcrEngine`

**Arquivos prováveis:**

- Criar: `src/vision/ocr-engine.ts`
- Criar: `src/vision/run-ocr.ts` ou worker equivalente
- Testar: `tests/ocr-engine.test.ts`

Gatilhos iniciais:

1. pergunta explícita do usuário sobre texto;
2. evento de objeto/placa/etiqueta que justifique OCR;
3. processamento manual de um snapshot ou clip.

Não executar OCR contínuo em todos os frames na primeira versão.

### Tarefa C3 — Guardas de privacidade

- Não registrar texto sensível em logs.
- Não enviar automaticamente OCR completo ao Telegram.
- Persistir referência da imagem e texto normalizado somente conforme política.
- Permitir redaction configurável para placas, documentos e dados pessoais.
- Auditar qual tool pediu a leitura.

**Aceitação:** OCR real em um snapshot de teste, evento `ocr.observation` persistente, busca textual e zero base64 no banco/audit log.

---

## 7. Fase D — Novas tools read-only para o Gemma

**Objetivo:** fazer o Gemma consultar a nova percepção sem receber autoridade operacional.

### Tools propostas

1. `search_object_observations`
   - classe, câmera, intervalo, confiança mínima e limite.
2. `search_ocr`
   - termo normalizado, intervalo, câmera e limite.
3. `search_recordings`
   - câmera, intervalo, objeto, OCR, evento e limite.
4. `get_recording`
   - metadata de um segmento/clip, sem devolver stream irrestrito.
5. `get_evidence`
   - retorna evento, snapshot/clip autorizado e origem.
6. `get_detector_status`
   - estado, PID, latência, erros e último heartbeat.
7. `get_camera_capabilities`
   - resolução, codec, áudio e capabilities conhecidas; não executar PTZ.

### Regras das tools

- Todas começam com risco `read`.
- Respostas têm IDs de evidência, timestamp, câmera e confiança.
- Limites baixos e paginação obrigatória.
- `get_recording` não deve colocar vídeo inteiro no prompt por padrão; retornar metadata ou clip curto solicitado.
- O `GroundingGuard` deve reconhecer evidência de snapshot, OCR, objeto e gravação.
- O prompt do Gemma deve diferenciar `observado`, `indexado`, `provável`, `incerto` e `desconhecido`.

**Arquivos prováveis:**

- Modificar: `src/tools/tool-registry.ts`
- Modificar: `src/orchestrator.ts`
- Modificar: `src/grounding/grounding-guard.ts`
- Testar: `tests/tool-registry.test.ts`, `tests/core.test.ts`, `tests/grounding-guard.test.ts`

**Aceitação:** o Gemma real consulta objeto/OCR/gravação em uma conversa read-only e a resposta cita a evidência correta, sem tool de escrita registrada.

---

## 8. Fase E — DVR local segmentado

**Objetivo:** transformar o RTSP em histórico de gravação pesquisável sem acoplar gravação ao LLM.

### Decisão inicial recomendada

A câmera entrega timestamps inválidos para `stream copy` tanto em vídeo quanto em áudio. O primeiro gravador confiável usa **transcodificação H.264 + AAC a 5 FPS**, com `ultrafast`, timestamps gerados e container Matroska. O custo de CPU e o tamanho dos segmentos devem continuar sendo medidos antes de gravação longa.

### Tarefa E1 — Segmentador controlado

**Arquivos prováveis:**

- Criar: `src/recordings/recording-manager.ts`
- Criar: `src/recordings/ffmpeg-recorder.ts`
- Testar: `tests/recording-manager.test.ts`

Requisitos:

- um processo FFmpeg por câmera;
- segmentos de duração configurável;
- reconexão limitada e backoff;
- encerramento limpo;
- nenhuma URL autenticada em logs;
- status de processo e segmento;
- não iniciar automaticamente sem decisão operacional específica;
- não apagar segmento sem política de retenção/backup.

### Tarefa E2 — Catálogo persistente

- Registrar segmento quando fechar com sucesso.
- Validar duração, bytes, codec e checksum.
- Indexar intervalo temporal por câmera.
- Relacionar eventos a segmentos por timestamp, nunca somente por nome de arquivo.
- Diferenciar arquivo local, clip derivado e cópia arquivada.

### Tarefa E3 — API read-only de histórico

Rotas prováveis:

- `GET /recordings`
- `GET /recordings/:id`
- `GET /recordings/:id/clip`
- `GET /recordings/:id/evidence`

A API deve permanecer bindada a `127.0.0.1` até existir autenticação/autorização adequada. Não abrir o DVR para LAN/internet nesta fase.

**Aceitação:** um segmento real curto é gravado, catalogado, lido após restart e associado a um evento/snapshot; o teste termina com rollback/limpeza documentados.

---

## 9. Fase F — Indexação de gravações por IA

**Objetivo:** conectar DVR e percepção sem analisar vídeo inteiro com Gemma.

Pipeline:

```text
segmento fechado
  ├─ metadata/checksum
  ├─ amostragem de frames
  │   ├─ detector de objetos
  │   └─ OCR somente quando aplicável
  └─ eventos/evidências ligados ao segmento
```

Regras:

- YOLO/ONNX processa frames amostrados.
- OCR só roda sob gatilho ou política configurada.
- Gemma não fica no loop de cada frame.
- Um clip curto pode ser criado em torno de evento confirmado com pre-roll/post-roll, se o buffer local permitir.
- A detecção em gravação histórica deve ser distinguida da observação ao vivo nos eventos.
- Reprocessamento deve ser idempotente por `segmentId + modelVersion + frameTimestamp`.

**Aceitação:** consultar “o que aconteceu entre X e Y?” recupera eventos, objetos/OCR e referências de gravação sem reanalisar tudo em tempo real.

---

## 10. Fase G — Arquivamento no Google Drive

**Objetivo:** reaproveitar a segurança do backup de snapshots para clips e gravações, sem transformar o Drive em DVR ao vivo.

### Decisão recomendada

O Drive deve ser **arquivo/backup**, não armazenamento primário de gravação contínua.

Ordem de prioridade:

1. snapshots de evidência;
2. clips de eventos confirmados;
3. exportações diárias ou segmentos selecionados;
4. gravação contínua completa somente se quota, custo e retenção forem aprovados.

### Tarefa G1 — Generalizar adapter

**Arquivos prováveis:**

- Criar: `src/media/media-backup.ts`
- Adaptar: `src/cameras/google-drive-backup.ts`
- Adaptar: `src/cameras/local-snapshot-store.ts` ou extrair storage comum
- Testar: `tests/google-drive-backup.test.ts`, `tests/media-backup.test.ts`

Requisitos:

- upload temporário;
- checksum/tamanho antes do envio;
- metadata readback pelo ID;
- estado `verified` antes de remover local;
- retry limitado;
- deduplicação;
- falha conserva o original local;
- nenhum token/URL/segredo em logs.

### Tarefa G2 — Política de retenção

Configurar separadamente:

- retenção local de snapshots;
- retenção local de segmentos;
- retenção de clips de eventos;
- janela de upload;
- pasta Drive por câmera/data/tipo;
- limite de bytes por dia;
- comportamento quando Drive estiver indisponível.

**Aceitação:** um clip real de teste é enviado, seu metadata é lido de volta, a cópia local é preservada até a política permitir remoção e o readback aparece no catálogo.

---

## 11. Fase H — Interface e operação

Somente depois das fases anteriores:

- tela read-only de timeline;
- busca por intervalo, pessoa/objeto e OCR;
- preview de snapshot e clip curto;
- health do Core, DVR, detector, OCR e Drive;
- métricas de latência, fila, erros, armazenamento e backup;
- exportação manual autorizada.

A UI não pode dar ao Gemma uma ferramenta de escrita implícita. Qualquer ação de controle deve passar por uma fase separada de autorização, política e feedback físico.

---

## 12. Ordem de execução recomendada

### Primeiro vertical slice

1. Contrato `object.observed` e `ocr.observation`.
2. Um detector de objeto adicional validado offline.
3. OCR em um snapshot escolhido manualmente.
4. Persistência e busca desses eventos.
5. Tools read-only para o Gemma.
6. Conversa real citando a evidência correta.

### Segundo vertical slice

1. Um segmento curto real via FFmpeg.
2. Registro no catálogo PostgreSQL.
3. Snapshot/objeto/OCR relacionados ao intervalo.
4. Busca pelo Gemma.
5. Clip curto arquivado no Drive com readback.

### Só depois

- gravação contínua longa com política de retenção;
- retenção longa e arquivamento automático em lote;
- timeline completa;
- dashboard;
- modelos adicionais em GPU;
- qualquer automação física.

---

## 13. Testes e critérios de aceite globais

Cada tarefa de código seguirá RED → GREEN → REFACTOR:

1. escrever teste de comportamento;
2. executar e observar falha esperada;
3. implementar o menor caminho;
4. executar teste específico;
5. executar suíte completa e build;
6. fazer smoke real somente em modo seguro;
7. verificar rollback e ausência de processos órfãos.

Critérios globais:

- `npm test` verde;
- `npm run build` verde;
- nenhum segredo em código, logs, eventos, prompts ou mapa;
- nenhum base64 persistido no PostgreSQL/audit log;
- IA local por padrão;
- tools do Gemma read-only;
- eventos com evidência verificável;
- gravação independente do LLM;
- Drive com upload + readback antes de qualquer exclusão;
- detector/OCR com status, PID, latência e erros observáveis;
- nenhum worker contínuo habilitado automaticamente durante desenvolvimento;
- automações físicas permanecem bloqueadas.

---

## 14. Riscos e decisões em aberto

1. **Armazenamento local:** medir espaço disponível antes de gravação contínua.
2. **Codec:** HEVC/PCM pode não tocar diretamente em todos os navegadores; testar remux/clip.
3. **VRAM:** a margem observada com Gemma residente ficou próxima de 1 GiB; manter percepção em CPU inicialmente.
4. **Drive:** gravação contínua pode consumir quota e aumentar custo; começar por evidências e clips.
5. **OCR:** placas e documentos exigem política explícita de privacidade.
6. **Objetos:** escolher classes por benchmark no cenário da câmera, não por catálogo genérico.
7. **Tracking:** não confundir tracking de objeto com identidade persistente.
8. **Modelo final:** Gemma e detector continuam substituíveis até métricas maiores.
9. **Startup:** o autostart foi revertido; qualquer nova persistência deverá ser uma decisão separada após o DVR estar validado.

## 15. Checkpoint de implementação

A primeira fatia deste plano foi implementada e exercitada:

- Contratos Zod para bounding boxes, observações de objeto, OCR e metadata de segmento.
- Inferência genérica YOLO/ONNX com classes COCO, mantendo o caminho `person.detected` compatível.
- Worker `object.observed` com confirmação temporal por classe.
- RapidOCR/ONNX em `tools/ocr/.venv`, selecionado após benchmark contra Tesseract.js; OCR sob demanda via `npm run ocr -- --once`.
- Evento `ocr.observation` ligado a `camera.snapshot`.
- Tools read-only do Gemma: `search_object_observations`, `search_ocr`, `get_detector_status`, `search_recordings`, `get_recording` e `get_timeline`.
- DVR manual em `npm run record -- --once` e `--continuous`, com H.264/AAC a 5 FPS porque o RTSP não fornece timestamps válidos para stream copy.
- Catálogo PostgreSQL, API `GET /recordings`, metadata e `GET /recordings/:id/clip` com proteção de path.
- Arquivamento manual em `npm run record:archive -- --id ...`, com upload/readback no Drive e cópia local preservada.
- Política `record:retention` implementada em dry-run por padrão; mede idade/tamanho, reconcilia arquivos e catálogo e não exclui mídia nesta fase.
- Scheduler periódico de arquivamento integrado ao servidor, condicionado a `JARVIS_RECORDING_BACKUP_ENABLED=true` e autenticação Drive; upload/readback é permitido, exclusão local continua desativada.
- Timeline compacta read-only em `GET /timeline` e `get_timeline`, sem carregar eventos completos/regions OCR no prompt.
- Conversa real do Gemma consultou o catálogo de gravações e respondeu com os segmentos corretos.
- Conversa real do Gemma consultou a timeline compacta e respondeu com 2 gravações e 10 eventos.
- Indexador histórico `index:recording` implementado: amostra frames por segmento, liga objetos/OCR a evidências com IDs determinísticos e reprocessa sem duplicar eventos.
- Um segmento real de 5 s foi indexado com `5` evidências e `5` OCRs; a segunda execução manteve `10` IDs únicos no PostgreSQL. A deduplicação de texto idêntico preserva as regiões originais.
- Filtro configurável `JARVIS_OCR_EXCLUDED_REGIONS` validado nos overlays fixos dos dois painéis; regiões originais continuam preservadas quando não excluídas.
- Verificação final: `43` arquivos de teste, `144` testes passando e build TypeScript OK.
- Benchmark sequencial do `gemma4:e2b-it-q4_K_M`: economia média efetiva de `1.312,5 MiB` de GPU (~30,9%), tool calling no Core aprovado, mas visão inadequada em dois snapshots reais; o tag foi removido do Ollama e o E4B continua como modelo padrão.

Pendências opcionais: coletar mais texto de cena real fora dos overlays para calibrar reconhecimento específico e, se desejado, ativar o batch Drive após aprovar quota/retensão. A execução padrão permanece sem exclusão local. O E2B foi descartado; qualquer novo modelo deverá passar por benchmark multimodal e exclusividade GPU comprovada. Regra operacional: carregar no máximo um modelo neural por vez na GPU.

## Resultado esperado

Ao final, o Jarvis deverá responder perguntas como:

- “Que objetos apareceram na frente de casa ontem?”
- “Que texto apareceu nessa imagem?”
- “O que aconteceu entre 18h e 19h?”
- “Me mostre a evidência da detecção.”
- “Existe uma gravação desse evento?”

Sempre com timestamp, câmera, confiança e referência de evidência — sem inventar fatos, sem depender de cloud e sem permitir que o LLM execute ações críticas.
