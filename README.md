# Jarvis Core

Core residencial modular em Node.js + TypeScript + ESM.

## Estado atual

- Ollama é executado no host Windows.
- Modelo padrão: `gemma-hermes:latest`.
- Tools disponíveis nesta versão: `get_home_state`, `get_house_knowledge`, `search_events`, `find_object`, `get_camera_snapshot`, `search_object_observations`, `search_ocr`, `get_detector_status`, `search_recordings`, `get_recording` e `get_timeline` — todas read-only.
- `search_events` aceita busca textual e filtros episódicos por intervalo, local, assunto e tipo.
- O World State projeta pessoas, objetos e portas (`door.opened`/`door.closed`) e ignora eventos atrasados por entidade.
- A câmera `front` usa RTSP direto via FFmpeg; a URL autenticada fica somente no `.env` local e não é registrada nos eventos.
- Eventos, estado e auditoria são persistidos em PostgreSQL no modo padrão; capturas visuais ficam em `data/snapshots`; o modo em memória fica disponível via `npm run dev:memory`.
- `GET /audit` consulta o histórico correlacionado de conversas, decisões de política e execuções de tools.
- `GET /cameras/:camera/health` valida a sessão RTSP sem salvar JPEG nem criar evento; o adapter usa UDP por padrão, timeout e retry curto.
- Retenção de snapshots: 7 dias, sem apagar antes de backup verificado. Para o DVR, a política nova é contínuo econômico por 30 dias, eventos por 90 dias e itens `protected` mantidos manualmente; staging local só pode ser removido após readback `verified`.
- O detector ONNX é um processo separado do Core/VLM e só é iniciado explicitamente com `npm run detector`; por padrão usa `yolo11n.onnx` em CPU. `npm run detector:objects -- --once` reconhece classes COCO selecionadas e `npm run ocr -- --once` roda RapidOCR sob demanda.
- O DVR grava segmentos locais H.264/AAC via FFmpeg, usa o perfil `continuous-economic` no modo contínuo, cataloga metadata/tier/checksum no PostgreSQL e expõe histórico/clip/timeline por API read-only. A fila Drive faz upload/readback idempotente; retenção remota é opt-in separado.
- O caminho de áudio PC é manual/opt-in: push-to-talk web ou `npm run audio:hotkey`, router local/Groq → Gemma → Piper CPU. O local continua default (`Faster-Whisper medium` em worker CPU); Groq só funciona com cloud habilitado, uma credencial backend configurada, quota local e confirmação. Sessões persistem transcript/metadata, nunca áudio bruto. Alexa usa adapter Home Assistant para `notify.echo_dot_speak`/`notify.echo_dot_announce`; nenhuma skill AWS própria é necessária.
- Tags de objetos/OCR preservam evidência, confiança, origem e status; watch sessions, importância e propostas de ação ficam separadas da política. Nenhuma tool de escrita, confirmação ou ação física está habilitada.

## Executar

```bash
npm install
docker compose up -d postgres
npm test
npm run build
npm run dev
```

Para executar sem PostgreSQL, somente em testes rápidos:

```bash
npm run dev:memory
```

A API inicia por padrão em `http://127.0.0.1:3000`.

### Dashboard, áudio e Tailscale

Depois de `npm run build`, o dashboard fica disponível no Core em:

```text
http://127.0.0.1:3000/ui/
```

Para a exposição somente na tailnet, mantendo o Core em loopback:

```bash
tailscale serve --bg 3000
```

O endereço é mostrado pelo próprio comando. Não use `tailscale funnel` para este dashboard.

Na aba **Câmeras**, o Core mantém o RTSP privado e serve vídeo contínuo de baixa latência em `GET /cameras/:camera/live-video` (`video/mp2t`, H.264 para o browser). A dashboard usa `mpegts.js` com buffer de estocagem desligado e chasing de latência; o processo FFmpeg é criado somente enquanto a tela está aberta e é encerrado quando a conexão fecha. A largura de saída padrão é `1280` (`JARVIS_LIVE_VIDEO_WIDTH`). O endpoint `/cameras/:camera/live` permanece como MJPEG legado e `/cameras/:camera/preview` como snapshot único.

Para operação durável no Windows, consulte `docs/windows-operation.md`. O supervisor opcional inicia PostgreSQL, Ollama e o Core compilado no login do usuário, com readback da tarefa e limites de reinício. Ele não inicia o detector, a hotkey, gravação contínua ou qualquer ação física.

O áudio local é opt-in por processo:

```bash
JARVIS_AUDIO_ENABLED=true JARVIS_TAILSCALE_SERVE_ENABLED=true npm run dev
```

No navegador, abra **Áudio** e segure o botão push-to-talk. Para o atalho global manual do Windows, sem Startup:

```bash
npm run audio:hotkey
```

O padrão é `Ctrl+Alt+J`; configure `JARVIS_VOICE_HOTKEY` se necessário. O helper captura enquanto a sessão está ativa, envia ao endpoint `/audio/pc` e reproduz a resposta no PC. Ele não mantém microfone aberto ao iniciar o projeto.

A descoberta atual do Home Assistant encontrou `media_player.sala_echo_dot`, `notify.echo_dot_speak` e `notify.echo_dot_announce`. O adapter Alexa/HA exige token/base URL configurados explicitamente; nenhuma skill AWS própria é usada.

### Detector ONNX separado

O detector é um processo separado do Core/VLM. Ele publica `camera.snapshot` e `person.detected` no Core via `POST /events` somente quando iniciado em modo explícito de publicação; por padrão, o CLI roda em `dry-run`, sem enviar eventos. O Core persiste, aplica ao World State e responde com o evento idempotente. Em falha transitória, o publicador repete o mesmo `id`, sem criar duplicata.

O detector não é iniciado automaticamente pelo `npm run dev`. Para uma captura controlada sem publicar eventos:

```bash
JARVIS_ONNX_MODEL_PATH=spikes/001-detector-benchmark/models/yolo11n.onnx \
JARVIS_CAMERA_FRONT_RTSP_URL='rtsp://CAMERA_HOST:554/STREAM_PATH' \
JARVIS_RTSP_TRANSPORT=udp \
  npm run detector -- --once
```

Para publicar explicitamente no Core, acrescente `--publish`:

```bash
npm run detector -- --once --publish
```

Para observar/inferir sem publicar eventos no Core, use `--dry-run` (pode ser combinado com `--once`):

```bash
JARVIS_ONNX_MODEL_PATH=spikes/001-detector-benchmark/models/yolo11n.onnx \
  npm run detector -- --once --dry-run
```

Nesse modo, eventos ficam somente em memória e nenhum `POST /events` é realizado.

Cada execução também mantém `data/detector/status.json` por padrão (ou o caminho de `JARVIS_DETECTOR_STATUS_FILE`). O arquivo é escrito de forma atômica e contém estado (`starting`, `healthy`, `degraded`, `stopped` ou `not_running`), PID, tentativas, sucessos, detecções, confirmações, eventos emitidos, erros, sobreposições puladas e último erro redigido. Ele não contém URL RTSP, credenciais ou imagens.

Para verificar o status sem iniciar nem alterar o detector:

```bash
npm run detector:status
```

O comando retorna código `0` somente para um processo `healthy` recente; status parado, degradado, stale, inválido ou sem processo retornam código diferente de zero.

Para executar o detector com supervisor manual, reinício limitado e `dry-run` seguro por padrão:

```bash
npm run detector:supervised
```

Use `npm run detector:supervised -- --publish` somente quando quiser publicar eventos no Core. `JARVIS_DETECTOR_MAX_RESTARTS` e `JARVIS_DETECTOR_RESTART_DELAY_MS` configuram o limite e o atraso entre reinícios. A tarefa de login do Core não inicia o detector; o detector continua manual e não é iniciado automaticamente.

Quando `JARVIS_TELEGRAM_NOTIFICATION_TARGET` está configurado, cada `person.detected` ONNX confirmado inclui no alerta Telegram o snapshot local usado como evidência (`MEDIA:<arquivo>`). O Core valida a referência dentro de `JARVIS_SNAPSHOT_DIR` antes do envio; se o arquivo já tiver sido removido ou estiver indisponível, o alerta textual continua sendo enviado sem a imagem. A notificação permanece somente informativa e não aciona automações físicas.

Para amostragem contínua observacional, remova `--once` e interrompa com `Ctrl+C`:

```bash
JARVIS_ONNX_MODEL_PATH=spikes/001-detector-benchmark/models/yolo11n.onnx \
JARVIS_CAMERA_FRONT_RTSP_URL='rtsp://CAMERA_HOST:554/STREAM_PATH' \
JARVIS_RTSP_TRANSPORT=udp \
  npm run detector
```

Esse comando continua em `dry-run`. Para publicação contínua, use `npm run detector -- --publish`; para operação supervisionada, prefira `npm run detector:supervised` e acrescente `-- --publish` somente com autorização explícita.

A janela de compatibilidade com o Gemma residente mediu 20 pontos de 1 segundo: VRAM entre `6921` e `6927 MiB` (média `6922,8`), utilização GPU `0%` e carga total de CPU média `30%`. O detector permaneceu em `CPUExecutionProvider` e não publicou eventos; a margem livre observada foi de aproximadamente `1,0 GiB`, portanto não carregar outro modelo GPU simultaneamente.

O detector usa por padrão duas detecções qualificadas consecutivas dentro de 5 segundos antes de publicar `person.detected`. Enquanto a presença continua visível, ele não repete o evento; uma captura sem detecção reinicia a sequência. Isso reduz eventos isolados, mas não substitui a calibração de ROI para objetos fixos.

Para coletar imagens diretamente do RTSP no enquadramento definitivo, use o script abaixo com `JARVIS_CAMERA_FRONT_RTSP_URL` configurada no ambiente local. O manifesto não guarda a URL:

```bash
python spikes/001-detector-benchmark/collect_rtsp_dataset.py \
  --output-dir spikes/001-detector-benchmark/dataset/final/negative \
  --label negative --count 20 --interval 2
```

Para positivos, fique em posições diferentes diante do portão e execute o mesmo comando trocando `--label positive`. Os rótulos continuam `null` até a revisão visual frame a frame.

O caminho configurado neste projeto é `spikes/001-detector-benchmark/models/yolo11n.onnx`; o runtime usa CPU de propósito, para não disputar a VRAM do Gemma. A captura RTSP usa UDP por padrão e o FFmpeg é encerrado após obter um frame; falhas têm timeout, retry limitado e mensagens sem a URL. Frigate/CUDA continua sendo um sidecar opcional para NVR, tracking e gravação.

### Objetos, OCR e DVR

A inferência genérica de objetos preserva o detector de pessoas e permite classes COCO como `car`, `motorcycle`, `bicycle`, `cat`, `dog` e `truck`:

```bash
npm run detector:objects -- --once
```

A captura OCR é sob demanda e usa RapidOCR/ONNX em `tools/ocr/.venv` (dependências declaradas em `tools/ocr/requirements.txt`):

```bash
npm run ocr -- --once
```

O DVR grava um segmento local e registra metadata/checksum no PostgreSQL:

```bash
JARVIS_RECORDING_DURATION_MS=10000 npm run record -- --once
```

Para gravação contínua manual, com segmentos econômicos de 60 segundos, use `--continuous`; ele não é iniciado automaticamente:

```bash
JARVIS_RECORDING_PROFILE=continuous-economic npm run record -- --continuous
```

O stream copy não foi promovido porque a câmera entrega timestamps inválidos. O perfil econômico gera H.264/AAC com escala/bitrate explícitos; o perfil `event-high-quality` fica disponível para clips relevantes. O histórico read-only está em `GET /recordings`, o metadata individual em `GET /recordings/:id` e o conteúdo local em `GET /recordings/:id/clip`.

Um segmento pode ser arquivado no Drive somente com ID explícito; o adapter faz upload, readback do metadata e atualiza o catálogo para `verified`. A fila automática de segmentos locais/falhos só é criada com `JARVIS_RECORDING_BACKUP_ENABLED=true`. A retenção remota 30/90 só é criada com `JARVIS_RECORDING_REMOTE_RETENTION_ENABLED=true`; por padrão usa lixeira reversível e preserva `protected`:

```bash
npm run record:archive -- --id rec-...
npm run record:retention
```

Para indexar um segmento histórico com objetos e OCR:

```bash
npm run index:recording -- --id rec-... --ocr
```

A timeline read-only junta gravações, eventos, objetos e OCR:

```bash
curl "http://127.0.0.1:3000/timeline?camera=front&from=2026-09-04T05:40:00Z&to=2026-09-04T05:50:00Z"
```

A retenção começa sempre em dry-run. O CLI mede candidatos por tier/idade/tamanho e não exclui arquivos nesse modo. Os defaults são 30 dias para contínuo e 90 dias para eventos; `protected` nunca entra na exclusão automática:

```bash
npm run record:retention
```

O scheduler de upload contínuo só é criado no Core quando `JARVIS_RECORDING_BACKUP_ENABLED=true` e o Drive está autenticado. Ele usa fila idempotente, retry e readback. A retenção remota só é criada com `JARVIS_RECORDING_REMOTE_RETENTION_ENABLED=true`; o padrão usa lixeira reversível. Remoção local depois do readback exige `JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY=true`.

### Primeira validação no local externo

No enquadramento definitivo, foram revisados **35 frames** capturados diretamente do RTSP: 20 frames da cena vazia, 7 frames vazios durante a passagem de teste e 8 frames com pessoa. Sem ROI e com limiar `0.35`, o YOLO11n/CPU obteve `TP=6`, `FN=2`, `FP=0`, `TN=27`, recall de `75%`, precisão de `100%` e FPR de `0%`. O resultado detalhado está em `spikes/001-detector-benchmark/results/dataset-final-evaluation-035.json`.

A ROI experimental do enquadramento antigo permaneceu desativada. O diagnóstico não encontrou detecções dentro dela nem interceptou as pessoas observadas, mas a área pode ser legítima para pessoas no novo cenário. O stream contém painéis superior e inferior; a coleta inicial exercitou pessoas no painel superior, sem provar ainda o auto-tracking do painel inferior. Automação física e fine-tuning continuam bloqueados até ampliar a coleta para noite, chuva/contraluz e o painel inferior.

Durante uma chegada real à noite, foram coletados mais 20 frames: 10 em infravermelho e 10 após ligar a luz branca, com carro, portas/tampa abertas, compras e múltiplas pessoas. No IR, o resultado foi `TP=4`, `FN=3`, `FP=1`, `TN=2`; com luz branca, `TP=7`, `FN=1`, `FP=1`, `TN=1`. Os falsos positivos vieram de porta/tampa, reflexos e sombras do carro. A confirmação temporal de 2 frames não confirmou esses falsos positivos isolados. Os resultados completos estão em `spikes/001-detector-benchmark/results/arrival-evaluation-035.json` e `arrival-threshold-sweep.json`; nenhum novo limiar foi ativado.

Um diagnóstico offline de 55 frames comparou o mosaico completo com os painéis superior/inferior recortados. O mosaico completo permaneceu melhor (`TP=17`, `FN=6`, `FP=2`, `TN=30`; recall `73,91%`, precisão `89,47%`, FPR `6,25%`), então não foi implementado recorte ingênuo por painel. A chegada noturna já forneceu uma observação do painel inferior/PTZ; falta apenas distinguir tecnicamente tracking físico de alternância de vistas, sem exigir nova ida agora.

Também foi executada uma janela observacional de 60 segundos do detector contínuo no RTSP real, com intervalo de 1 segundo e confirmação de 2 frames. Não houve detecções nem eventos `onnx` persistidos; o worker foi encerrado ao final e não fica iniciado automaticamente.

Uma janela adicional de 30 minutos em `dry-run` percorreu **1.800 frames** sem publicar no Core nem no Telegram. A reprodução offline encontrou **14 sequências** que passaram pela confirmação temporal; o usuário validou manualmente **14/14 como pessoas**, sem falso positivo ou inconclusivo. Os rótulos e posições dos painéis estão em `data/reviews/observation-2026-09-02/manifest.json`; a reexecução offline em `0.35` detectou `14/14`, com resultado em `spikes/001-detector-benchmark/results/observation-review-035.json`. Esse lote foi selecionado por detecção e não é uma métrica independente de recall.

Uma inspeção direta de metadados do RTSP encontrou um único vídeo HEVC `1920×2160` a `15 FPS` e um stream de áudio PCM, sem metadados publicados de PTZ, controle ou canais separados de painel. A porta HTTP da câmera e o Agent DVR estavam indisponíveis durante a consulta; isso não prova ausência de PTZ, apenas deixa a distinção entre tracking físico e alternância de vistas não comprovada. O detector continua usando o mosaico completo.

## Continuidade

O plano inicial e o contexto técnico persistente estão em:

```text
.hermes/plans/2026-08-29_005004-jarvis-core-v0-1.md
```

## Endpoints

### Saúde

```bash
curl http://127.0.0.1:3000/health
```

### Saúde da câmera

```bash
curl http://127.0.0.1:3000/cameras/front/health
```

O health check é somente leitura: não salva JPEG e não cria evento.

### Gravações

```bash
curl "http://127.0.0.1:3000/recordings?camera=front&limit=20"
curl "http://127.0.0.1:3000/recordings/rec-..."
curl "http://127.0.0.1:3000/recordings/rec-.../clip" --output clip.mkv
```

O catálogo e o clip são somente leitura. O servidor valida a referência dentro de `JARVIS_RECORDING_OUTPUT_DIR` e não expõe caminhos arbitrários.

### Conversa

```bash
curl -X POST http://127.0.0.1:3000/conversation \
  -H "content-type: application/json" \
  -d '{"message":"Tem alguém no quintal?"}'
```

### Registrar evento

```bash
curl -X POST http://127.0.0.1:3000/events \
  -H "content-type: application/json" \
  -d '{
    "id":"evt-001",
    "type":"person.detected",
    "timestamp":"2026-08-25T19:12:31-03:00",
    "source":{"type":"camera","id":"front"},
    "location":"quintal",
    "subject":{"type":"person","id":"unknown-01"},
    "confidence":0.81,
    "data":{}
  }'
```

### Auditoria

```bash
# Todas as entradas recentes
curl "http://127.0.0.1:3000/audit?limit=100"

# Uma conversa específica (o POST /conversation devolve conversationId)
curl "http://127.0.0.1:3000/audit?conversationId=conv-..."
```

Cada conversa registra o input, a sugestão de tool do modelo, a decisão da Policy Engine, o resultado da execução e a resposta final. Campos sensíveis e imagens em base64 são redigidos antes de persistir.

### Backup automático e retenção

Com o OAuth do Google Drive autenticado no perfil Hermes ativo, o scheduler de snapshots continua separado do DVR. Para o DVR, `JARVIS_RECORDING_BACKUP_ENABLED=true` cria a fila de segmentos locais/falhos; cada arquivo passa por upload e readback antes de `verified`. `JARVIS_RECORDING_REMOTE_RETENTION_ENABLED=true` cria a limpeza remota por tier, usando lixeira por padrão. Em qualquer falha, o staging é preservado e o item fica disponível para retry.

O diretório opcional `JARVIS_DRIVE_PARENT_FOLDER_ID` escolhe uma pasta existente; sem ele, o upload usa a unidade padrão. O adapter usa o wrapper OAuth do Hermes e não coloca tokens ou base64 no Core.

## Configuração

- `JARVIS_MODEL` — modelo do Ollama; padrão `gemma-hermes:latest`.
- `OLLAMA_BASE_URL` — URL do Ollama; padrão `http://127.0.0.1:11434`.
- `DATABASE_URL` — conexão PostgreSQL usada pelo Core; o detector publica eventos via HTTP e não precisa abrir essa conexão.
- `JARVIS_CORE_BASE_URL` — URL local do Core usada pelo detector para `POST /events`; padrão `http://127.0.0.1:3000`.
- `JARVIS_TELEGRAM_NOTIFICATION_TARGET` — target opcional para alertas somente de `person.detected` ONNX confirmado; sem a variável, notificações ficam desativadas.
- `JARVIS_CAMERA_FRONT_RTSP_URL` — URL RTSP da câmera `front`; obrigatória para habilitar captura, mantida apenas no `.env` local.
- `JARVIS_RTSP_TRANSPORT` — transporte do stream; padrão `udp` (a câmera validada exige UDP).
- `JARVIS_SNAPSHOT_DIR` — diretório dos snapshots; padrão `data/snapshots`. A limpeza usa 7 dias e exige backup configurado antes de apagar arquivos expirados.
- `JARVIS_DRIVE_PARENT_FOLDER_ID` — ID opcional de uma pasta existente no Google Drive para os backups.
- `JARVIS_ONNX_MODEL_PATH` — caminho do modelo ONNX do detector; na configuração deste projeto, `spikes/001-detector-benchmark/models/yolo11n.onnx`.
- `JARVIS_ONNX_INPUT_SIZE` — lado da entrada quadrada do modelo; padrão `640`.
- `JARVIS_DETECTOR_CAMERA` — câmera lógica amostrada pelo worker; padrão `front`.
- `JARVIS_DETECTOR_INTERVAL_MS` — intervalo entre capturas no modo contínuo; padrão `1000`.
- `JARVIS_DETECTOR_STATUS_FILE` — caminho do status operacional JSON; padrão `data/detector/status.json`.
- `JARVIS_DETECTOR_STATUS_MAX_AGE_MS` — idade máxima aceita pelo `detector:status`; padrão `30000`.
- `JARVIS_DETECTOR_CONFIDENCE_THRESHOLD` — limiar de pessoa; padrão `0.35`.
- `JARVIS_DETECTOR_CONFIRMATION_FRAMES` — observações qualificadas consecutivas antes de emitir evento; padrão `2`.
- `JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS` — janela máxima entre observações; padrão `5000`.
- `JARVIS_DETECTOR_EXCLUDED_REGIONS` — JSON opcional com regiões por câmera, em coordenadas da entrada do modelo; exemplo candidato ainda não ativado: `{"front":[{"x1":400,"y1":0,"x2":520,"y2":180}]}`.
- `JARVIS_OBJECT_DETECTOR_CLASSES` — classes COCO separadas por vírgula para `detector:objects`; padrão `person,car,motorcycle,bicycle,cat,dog,truck`.
- `JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD` — limiar do detector genérico; padrão `0.35`.
- `JARVIS_OBJECT_DETECTOR_CONFIRMATION_FRAMES` — confirmações do worker genérico; padrão `2`.
- `JARVIS_OBJECT_DETECTOR_CONFIRMATION_WINDOW_MS` — janela do worker genérico; padrão `5000`.
- `JARVIS_OCR_PYTHON` — Python do worker RapidOCR; se vazio, usa `tools/ocr/.venv/Scripts/python.exe` quando existente.
- `JARVIS_OCR_WORKER` — caminho opcional do worker Python RapidOCR; padrão `tools/ocr/rapidocr_worker.py`.
- `JARVIS_OCR_EXCLUDED_REGIONS` — JSON opcional por câmera para ignorar overlays fixos; a região filtra pelo centro da caixa e não esconde áreas por default.
- `JARVIS_OCR_CAMERA` — câmera usada pelo CLI OCR; padrão `front`.
- `JARVIS_OCR_MODEL` — identificador lógico do OCR; padrão `rapidocr-onnxruntime`.
- `JARVIS_RECORDING_CAMERA` — câmera gravada pelo CLI DVR; padrão `front`.
- `JARVIS_RECORDING_OUTPUT_DIR` — raiz local das gravações; padrão `data/recordings`.
- `JARVIS_RECORDING_DURATION_MS` — duração de cada segmento; padrão `10000` no CLI.
- `JARVIS_RECORDING_VIDEO_FPS` — FPS da transcodificação DVR; padrão `5`.
- `JARVIS_RECORDING_VIDEO_PRESET` — preset H.264; padrão `ultrafast`.
- `JARVIS_RECORDING_RETRY_DELAY_MS` — atraso entre falhas em `--continuous`; padrão `5000`.
- `JARVIS_AUDIO_ENABLED` — habilita o pipeline PC; `false` por padrão.
- `JARVIS_STT_MODEL` — modelo Faster-Whisper CPU; padrão `medium` para melhor reconhecimento em português; `small`/`base` permanecem como alternativas de menor custo.
- `JARVIS_STT_ROUTE` — rota `local`, `groq` ou `auto`; padrão `local`.
- `JARVIS_STT_LANGUAGE` — idioma do STT; padrão `pt-BR`.
- `JARVIS_STT_FALLBACK` — fallback permitido; `none` ou `local`, padrão `none`.
- `JARVIS_STT_TIMEOUT_MS` — timeout do provider cloud; padrão `12000`.
- `JARVIS_GROQ_STT_MODEL` — modelo Groq allowlisted; padrão `whisper-large-v3-turbo`.
- `GROQ_API_KEY` — segredo somente do backend; nunca é retornado pela API/dashboard e não deve ser documentado com valor.
- `JARVIS_STT_MAX_REQUESTS_PER_DAY`, `JARVIS_STT_MAX_AUDIO_SECONDS_PER_DAY` e `JARVIS_STT_MAX_ESTIMATED_MONTHLY_USD` — teto local independente dos limites da organização Groq.
- `JARVIS_AUDIO_SESSION_AUTO_DELETE` — habilita retenção automática de sessões; `false` por padrão.
- `JARVIS_AUDIO_SESSION_RETENTION_DAYS` — idade mínima da retenção automática; padrão `30`.
- `JARVIS_AUDIO_SESSION_RETENTION_INTERVAL_MS` — intervalo do scheduler de sessões; padrão `86400000`.
- `JARVIS_PIPER_MODEL` — voz Piper ONNX; padrão `models/tts/piper/pt_BR-jeff-medium.onnx`.
- `PIPER_COMMAND` — executável Piper opcional; padrão `piper` no PATH. O Core não força `python -m piper`.
- `JARVIS_CLOUD_TTS_ENABLED`/`JARVIS_CLOUD_STT_ENABLED` — gates independentes para fallback cloud; desligados por padrão.
- `npm run benchmark:stt -- --audio <fixture.wav>` — compara Faster-Whisper local e, se houver chave backend, os modelos Groq allowlisted; veja `docs/stt-benchmark-template.md`.
- `JARVIS_VOICE_HOTKEY` — atalho do helper Windows; padrão `ctrl+alt+j`.
- `JARVIS_TAILSCALE_SERVE_ENABLED` — somente indicador de health; o proxy é configurado com `tailscale serve`, nunca `funnel`.
- `JARVIS_RECORDING_BACKUP_ENABLED` — habilita a fila de arquivamento DVR no Core somente com valor `true`; padrão desabilitado.
- `JARVIS_RECORDING_BACKUP_INTERVAL_MS` — intervalo da fila de arquivamento; padrão `3600000` (1 hora).
- `JARVIS_RECORDING_UPLOAD_MAX_ATTEMPTS` — tentativas máximas por segmento; padrão `5`.
- `JARVIS_RECORDING_UPLOAD_RETRY_DELAY_MS` — atraso inicial entre retries; padrão `2000`.
- `JARVIS_RECORDING_REMOTE_RETENTION_ENABLED` — habilita retenção remota 30/90; padrão desabilitado.
- `JARVIS_DRIVE_PERMANENT_DELETE` — usa delete permanente em vez de lixeira; padrão desabilitado.
- `JARVIS_RECORDING_RETENTION_INTERVAL_MS` — intervalo da retenção local; padrão `21600000` (6 horas).
- `JARVIS_RECORDING_REMOTE_RETENTION_INTERVAL_MS` — intervalo da retenção remota; padrão `86400000` (24 horas).
- `JARVIS_RECORDING_INDEX_INTERVAL_MS` — intervalo de amostragem do indexador histórico; padrão `1000`.
- `JARVIS_RECORDING_MAX_AGE_DAYS` — retenção contínua; padrão `30`.
- `JARVIS_RECORDING_EVENT_MAX_AGE_DAYS` — retenção de eventos; padrão `90`.
- `JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY` — permite remover staging após readback; padrão desabilitado.
- `JARVIS_RECORDING_MAX_BYTES` — limite local opcional usado pelo dry-run de retenção.
- `JARVIS_CAMERA_FRONT_LOCATION` — localização semântica usada nos eventos da câmera `front`; padrão `frente`.
- `JARVIS_LIVE_VIDEO_WIDTH` — largura do vídeo contínuo H.264/MPEG-TS; padrão `1280`, entre `320` e `1920`.
- `FFMPEG_PATH` — executável FFmpeg opcional; padrão `ffmpeg` encontrado no `PATH`.
- `PORT` — porta HTTP; padrão `3000`.
- `HOST` — bind HTTP; padrão `127.0.0.1`.
