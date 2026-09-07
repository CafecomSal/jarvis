# Spike 001 — detector ONNX/CPU/CUDA versus Frigate

## Pergunta

Para uma única câmera `front`, um detector local ONNX e o Frigate com CPU/CUDA são alternativas viáveis sem comprometer a margem de VRAM do Gemma?

## Escopo e limitações

- Entrada inicial: dois JPEGs reais da câmera `front`, obtidos pelo caminho temporário disponível no começo do spike, ambos com 320×240.
- Dataset adicional: 5 capturas revisadas frame a frame, com 3 positivos e 2 negativos; os 5 negativos da primeira coleta e 5 frames de uma tentativa anterior também foram mantidos.
- Hard negatives: 8 frames reais da janela contínua em que a planta/objetos fixos confundiram o detector.
- Dataset temporário de baseline: **23 frames rotulados**, com **3 positivos** e **20 negativos**. Os rótulos foram registrados nos manifestos após revisão visual.
- Dataset externo inicial: **35 frames revisados**, com **8 positivos reais** e **27 negativos**; ele representa o enquadramento definitivo apenas no fim da tarde e ainda não cobre noite, chuva ou o tracking do painel inferior.
- Janela observacional adicional: **14 sequências confirmadas pelo detector**, todas reclassificadas manualmente pelo usuário como pessoas válidas; os JPEGs e rótulos estão em `data/reviews/observation-2026-09-02/manifest.json`. Esses quadros são amostras selecionadas por detecção e não entram como métrica independente de recall.
- O dataset é pequeno e serve para validar o caminho; não representa precisão geral em diferentes iluminação, distâncias ou ângulos.
- O worker ONNX agora está implementado separadamente do Core/VLM; o spike continua sem representar uma validação de produção completa.

## Abordagens

| Abordagem | Execução | Modelo | Threads | Resultado |
|---|---|---|---:|---|
| ONNX direto | `onnxruntime` com `CPUExecutionProvider` | `yolo11n.onnx` oficial, asset Ultralytics `v8.3.0` | 2 | Inferência local mensurável e sem GPU |
| Frigate | container descartável `ghcr.io/blakeblackshear/frigate:stable` | detector CPU/TFLite interno | 2 | Inicializou e processou o stream MJPEG |
| Frigate GPU | container descartável `ghcr.io/blakeblackshear/frigate:stable-tensorrt` com `--gpus all` | `yolov9-t-320.onnx`, `yolo-generic` | CUDA automático | Detector carregado pela RTX 4060 |

## Como reproduzir

A partir da raiz do repositório:

```bash
python spikes/001-detector-benchmark/run_onnx.py \
  --image data/snapshots/front/2026-08-29T045230972Z-42af731c-573d-426c-9840-835d7c80b95d.jpg \
  --image data/snapshots/front/2026-08-29T044757397Z-5bd3a40f-fb5d-48f0-885d-7047ef5f4148.jpg \
  --iterations 20 --warmup 3 --threads 2 \
  --output spikes/001-detector-benchmark/results/onnx-cpu.json
```

Para o teste Frigate, o spike usa `mjpeg_server.py` para repetir os mesmos JPEGs e `frigate-config/config.yml` com:

- uma câmera `front`;
- `preset-http-mjpeg-generic`;
- detector `cpu1` com 2 threads;
- 2 FPS configurados;
- gravação e snapshots desativados.

A API de métricas do Frigate foi consultada via HTTPS local (`/api/stats`) durante 30 segundos por `collect_frigate.py`. O container e o servidor MJPEG foram encerrados após a coleta.

Para o teste GPU, a imagem `stable-tensorrt` foi executada com `--gpus all`, o provider foi conferido pela função `get_ort_providers(False, "AUTO")` e retornou `CUDAExecutionProvider` antes de CPU. O Frigate `0.17.x` em amd64 não aceita mais o detector legado `type: tensorrt`; o YAML usa `type: onnx` com o provider CUDA da imagem.

## Resultados

### ONNX/CPU direto

- Runtime: ONNX Runtime `1.29.0`.
- Provider: `CPUExecutionProvider`.
- Entrada: 640×640, 2 threads, 3 warmups, 20 inferências.
- Inferência média: **46,47 ms**.
- Mediana/p50: **44,83 ms**.
- p95: **53,27 ms**.
- Throughput teórico de inferência: **21,52 FPS**.
- Pessoas detectadas nos 20 frames: **0**.
- O processo não solicitou GPU.

### Frigate CPU

- Imagem: `ghcr.io/blakeblackshear/frigate:stable`.
- Versão iniciada: `0.17.2-3d4dd3a`.
- Amostras: 6 em aproximadamente 30 segundos, sem falhas de coleta.
- Inferência média do detector: **19,57 ms**.
- Inferência mínima/máxima: **19,5–19,7 ms**.
- FPS efetivo observado da câmera: **0,2 FPS**.
- FPS efetivo de detecção observado: **0,4 FPS**.
- `detection_enabled`: `true`.
- Uso médio reportado pelo próprio Frigate para `frigate.full_system`: **0,87% CPU** e **7,67% memória**.
- `docker stats` ao final: **0,58% CPU** e **560,9 MiB / 3,52%** de memória do limite reportado.
- Falsos positivos nos frames negativos observados: **0**.
- Imagem Docker em cache: **7,48 GB**.
- A configuração inicial falhou porque Frigate aplicou argumentos RTSP a uma URL HTTP; o preset `preset-http-mjpeg-generic` corrigiu a entrada.

A VRAM permaneceu no patamar do ambiente com Gemma carregada; o container foi iniciado sem solicitação de GPU. A leitura final de `nvidia-smi` foi 1.708 MiB usados de 8.188 MiB, sem evidência de alocação do Frigate na GPU.

### Frigate GPU / CUDA

- Imagem: `ghcr.io/blakeblackshear/frigate:stable-tensorrt`.
- Imagem em cache: **12,9 GB**.
- Versão iniciada: `0.17.2-3d4dd3a`.
- Modelo: YOLOv9 tiny estático, `yolov9-t-320.onnx`, entrada 320×320.
- Execução: `--gpus all`; o container expôs uma NVIDIA GeForce RTX 4060.
- Provider selecionado pelo Frigate: `CUDAExecutionProvider`, com CPU como fallback.
- Amostras: 6 em aproximadamente 30 segundos, sem falhas de coleta.
- Inferência média reportada pelo detector: **10,0 ms**.
- FPS efetivo observado da câmera: **0,2 FPS**; detecção efetiva: **0,0 FPS**, pois a entrada sintética não gerou uma janela de movimento detectável. Esses valores não representam throughput RTSP real.
- `detection_enabled`: `true`.
- `docker stats` durante a coleta: aproximadamente **1,24% CPU** e **1,554 GiB / 9,97%** de memória do limite reportado.
- VRAM observada durante o container: aproximadamente **1.906 MiB** de 8.188 MiB; a listagem de processos CUDA do Docker Desktop não expôs um PID atribuível ao container, então a variação não é atribuída exclusivamente ao Frigate.

Como controle adicional, o mesmo YOLOv9 rodou diretamente com `CUDAExecutionProvider` dentro da imagem TensorRT: média **19,62 ms**, p95 **28,88 ms** e throughput teórico **50,96 FPS**. Essa medição não é end-to-end do Frigate, mas confirma que o modelo e a GPU executam fora do CUDA Graph problemático do YOLO11.

### Dataset anotado e avaliação

- Ground truth inicial: 15 frames, sendo 3 com pessoa e 12 sem pessoa.
- `yolo11n.onnx` em `CPUExecutionProvider`, entrada 640×640: **TP=2, FN=1, FP=0, TN=12**, recall **66,67%**, precisão **100%**, taxa de falso positivo **0%**. Latência média: 49,88 ms no lote positivo e 50,25 ms no lote negativo.
- `yolov9-t-320.onnx` em `CUDAExecutionProvider`, entrada 320×320: **TP=1, FN=2, FP=0, TN=12**, recall **33,33%**, precisão **100%**, taxa de falso positivo **0%**. Latência média: 17,56 ms no lote positivo e 14,66 ms no lote negativo.
- A amostra inicial confirma maior recall do YOLO11/CPU neste enquadramento, enquanto o YOLOv9/CUDA é mais rápido. Como há apenas 3 positivos, nenhuma taxa deve ser tratada como desempenho final.

Na avaliação estendida com 8 hard negatives e limiar `0.35`:

- `yolo11n.onnx`/CPU: **TP=2, FN=1, FP=2, TN=18**, recall **66,67%**, precisão **50%**, taxa de falso positivo **10%**, média de aproximadamente **51,6 ms**.
- `yolov9-t-320.onnx`/CUDA: **TP=1, FN=2, FP=0, TN=20**, recall **33,33%**, precisão **100%**, taxa de falso positivo **0%**, média de aproximadamente **21,4 ms**.
- A região candidata `front: [{"x1":400,"y1":0,"x2":520,"y2":180}]`, aplicada pelo centro da caixa, removeu os dois hard negatives novos e preservou os dois frames positivos testados fora dela. Ela não é ativada por padrão, pois uma pessoa nessa região seria intencionalmente ignorada.
- Resultado detalhado: `results/dataset-evaluation-extended-035.json`.
### Ingestão RTSP real

- A URL da câmera `front` foi recuperada de uma configuração local existente somente para o teste; a captura foi feita pelo FFmpeg/RTSP direto, sem usar Agent DVR como servidor.
- O transporte TCP foi rejeitado pela câmera com `Nonmatching transport in server reply`.
- O transporte UDP abriu o substream `HEVC 1920×2160` a `15 FPS`.
- FFmpeg decodificou **5 frames JPEG válidos** com filtro de 1 FPS e retorno `0`; os arquivos temporários variaram de aproximadamente 726 KB a 728 KB.
- FFmpeg emitiu avisos intermitentes de referência HEVC durante a recuperação do stream UDP, mas todos os cinco frames foram produzidos e validados pelo FFprobe.
- Resultado detalhado: `results/rtsp-ingestion.json`.

### Validação externa — chegada noturna

- Foram capturados **20 frames** diretamente do RTSP durante uma chegada real, com carro, portas/tampa abertas, compras e múltiplas pessoas.
- Lote IR: **7 positivos** e **3 negativos**; YOLO11n/CPU em `0.35`: `TP=4`, `FN=3`, `FP=1`, `TN=2`, recall `57,14%`, precisão `80%`, FPR `33,33%`.
- Lote com luz branca: **8 positivos** e **2 negativos**; em `0.35`: `TP=7`, `FN=1`, `FP=1`, `TN=1`, recall `87,5%`, precisão `87,5%`, FPR `50%`.
- Conjunto combinado: `TP=11`, `FN=4`, `FP=2`, `TN=3`, recall `73,33%`, precisão `84,62%`, FPR `40%`. A amostra negativa é pequena e contém somente situações com carro, portanto o FPR não é uma estimativa geral.
- Os falsos positivos foram visualmente atribuídos a porta/tampa aberta, reflexos e sombras do carro, com confiança `0.384` e `0.406`. Os falsos negativos ocorreram em pessoas parcialmente ocultas pelo veículo, inclinadas ou em IR com baixo contraste.
- Varredura de limiar: `0.40` removeu o falso positivo IR sem perder TP, mas manteve o falso positivo com luz; `0.45` removeu ambos, porém reduziu o conjunto combinado para `TP=9` e `FN=6`. Nenhum limiar foi promovido para produção.
- A confirmação temporal padrão (2 observações em até 5 s) não confirmou os dois falsos positivos isolados observados nessa sequência; ela continua sendo a barreira principal contra alertas únicos.
- O stream possui dois painéis verticais. A chegada noturna já serviu como teste observacional do painel inferior: pessoas apareceram próximas ao carro e houve mudança compatível com acompanhamento/alternância nos quadros IR intermediários. Ainda não é possível separar apenas pelos frames se foi tracking físico ou alternância entre vistas, mas isso não bloqueia o próximo passo e não exige nova ida agora.
- Resultado detalhado: `results/arrival-evaluation-035.json` e `results/arrival-threshold-sweep.json`.

### Diagnóstico de painéis e recorte

- Um benchmark offline comparou o frame mosaico completo, o painel superior, o painel inferior e a união das detecções em **55 frames** (35 da validação diurna + 20 da chegada noturna).
- O mosaico completo foi o melhor baseline: `TP=17`, `FN=6`, `FP=2`, `TN=30`, recall `73,91%`, precisão `89,47%` e FPR `6,25%`.
- O recorte ingênuo do painel superior reduziu o recall para `65,22%`; o painel inferior sozinho teve recall de `13,04%`; a união não superou o frame completo.
- Portanto, não implementar recorte por painel ainda. O próximo teste deve controlar o PTZ/alternância de vistas e só então avaliar pré-processamento específico; por enquanto o detector continua recebendo o mosaico completo.

### Smoke do worker contínuo

- O scheduler inicialmente encerrava o processo por usar `unref()`; isso foi reproduzido por teste, corrigido e coberto por regressão.
- Após a validação externa, o detector contínuo foi exercitado por uma janela observacional limitada de **60 segundos**, com RTSP real, intervalo de 1 segundo e confirmação de 2 frames; não houve detecção no log, não houve evento `onnx` no readback do Core e o worker foi encerrado explicitamente ao final.
- Implementado e testado `--dry-run`: o detector pode executar captura/inferência contínua ou `--once` usando `InMemoryEventStore`, sem enviar `POST /events`; o smoke real `npm run detector -- --once --dry-run` capturou e inferiu um frame RTSP sem pessoa.
- Implementado supervisor manual `npm run detector:supervised`, com `dry-run` por padrão, `--publish` opt-in, reinício limitado e atraso configurável; no smoke Windows, a morte abrupta do supervisor não deixou o detector filho órfão graças ao monitor de vida do pai.
- Implementado dispatcher de notificação Telegram opt-in no Core: somente eventos ONNX com `confirmed: true`, deduplicação por ID e falha de Telegram isolada da persistência; nenhum alerta artificial foi enviado durante os testes.
- O alerta confirmado agora transporta a referência do snapshot de evidência e envia texto + imagem via `MEDIA:<arquivo>`; o Core valida o caminho dentro do diretório local e cai para texto somente quando a imagem não está disponível.
- A janela observacional adicional de 30 minutos em `dry-run` percorreu 1.800 frames sem persistir eventos; a reprodução offline encontrou 14 sequências confirmadas. A triagem visual preliminar indicou 5 quadros com pessoa aparente, 4 inconclusivos e 5 prováveis falsos positivos ambientais. O resultado é apenas triagem e não deve ser tratado como métrica definitiva.
- Depois da correção, o worker CPU permaneceu ativo por mais de 20 segundos com intervalo de 1 segundo e câmera `front` saudável.
- A VRAM observada variou de `3754 MiB` antes para `2952 MiB` durante a janela; como o Gemma/Ollama e outras atividades também estavam usando a GPU, não há base para atribuir essa variação ao worker. O provider do worker era explicitamente `CPUExecutionProvider`.
- Com limiar `0.35`, o YOLO11 ainda confundiu plantas/objetos fixos na região superior direita, com confianças de `0.351` e `0.411`. Os eventos e evidências desse smoke foram removidos do PostgreSQL após a análise; a verificação final retornou zero resíduos.
- Portanto, o modo contínuo está operacional, mas **não deve ser habilitado como automação de produção** antes de aplicar confirmação temporal, máscara/ROI calibrada ou outra estratégia de redução desse falso positivo.

## Artefatos

- `models/yolo11n.onnx` — modelo baixado para o spike.
- `run_onnx.py` — benchmark direto com pré-processamento FFmpeg, NMS de pessoa e percentis.
- `mjpeg_server.py` — fonte MJPEG descartável para comparação.
- `collect_frigate.py` — coleta da API de métricas do Frigate.
- `collect_rtsp_dataset.py` — coletor de frames rotulados a partir do RTSP direto, com manifesto sem URL.
- `test_collect_rtsp_dataset.py` — testes do coletor RTSP e da redação da origem.
- `frigate-config/config.yml` — configuração descartável.
- `frigate-gpu-config/config.yml` — configuração GPU descartável.
- `frigate-object-detectors.md` e `frigate-object-detector-models.yml` — referências oficiais usadas no spike.
- `frigate-model-build/yolov9-t-320.onnx` — modelo YOLOv9 estático exportado para o teste.
- `results/rtsp-ingestion.json` — resultado da validação RTSP/UDP com FFmpeg.
- `results/dataset-evaluation-extended-035.json` — avaliação ampliada com hard negatives e limiar 0,35.
- `results/onnx-all-cpu-035.json` e `results/onnx-all-cuda-yolov9-035.json` — inferências brutas dos 23 frames.
- `dataset/front/positive/manifest.json` — manifest de capturas revisadas como positivas ou negativas conforme o frame.
- `dataset/front/negative/manifest.json` — manifest dos frames negativos revisados.
- `results/onnx-cpu.json` — saída do benchmark ONNX.
- `results/frigate-cpu.json` — saída da janela Frigate.
- `results/onnx-cuda-yolov9.json` — saída do ONNX Runtime direto na CUDA.
- `results/frigate-gpu.json` — saída da janela Frigate com CUDA.

## Verdict: PARTIAL

### O que funcionou

- ONNX Runtime executou o modelo de detecção em CPU, com throughput suficiente para uma câmera se amostrarmos frames e não necessariamente processarmos o stream inteiro.
- Frigate iniciou com detector CPU e expôs métricas verificáveis.
- Frigate iniciou com a imagem TensorRT, carregou o modelo YOLOv9 e selecionou `CUDAExecutionProvider` na RTX 4060.
- A inferência direta do mesmo YOLOv9 em CUDA também funcionou, sem depender do CUDA Graph do Frigate.
- Nenhum dos dois caminhos produziu falso positivo nos dois frames negativos.
- O Frigate CPU não consumiu a GPU quando executado sem runtime/dispositivo GPU.

### O que não foi provado

- Recall/precisão em produção: o dataset anotado agora permite uma primeira medição, mas não representa condições gerais nem substitui validação contínua.
- Generalização do recall/precisão: o dataset estendido mede o comportamento em 23 frames, mas continua pequeno e concentrado em uma única câmera/cena.
- Throughput end-to-end de longa duração sobre uma sessão RTSP: o adapter e o CLI já capturam diretamente via UDP, mas uma janela contínua prolongada ainda não foi medida no cenário externo definitivo.
- Impacto em longo prazo ou com múltiplas câmeras.
- Falso positivo em cena real: o smoke contínuo encontrou uma planta/objeto fixo com confiança de até `0.411`; os 8 hard negatives foram adicionados para medir e calibrar esse caso.
- Confirmação temporal: o worker/CLI agora exigem, por padrão, 2 detecções qualificadas em até 5 segundos e emitem um único evento por presença; os valores ainda devem ser calibrados no cenário externo.

### Surpresas

- O detector CPU do Frigate foi mais rápido por inferência que o runner ONNX com o mesmo limite de 2 threads, mas o pacote operacional é muito maior.
- A imagem `stable` do Frigate ocupou 7,48 GB, o que pesa contra colocá-lo na stack permanente apenas para uma câmera.
- A imagem `stable-tensorrt` ocupou 12,9 GB, mas entregou 10,0 ms por inferência com CUDA usando um modelo YOLOv9 compatível.
- O detector legado `type: tensorrt` não é aceito pelo Frigate `0.17.2` em amd64; o caminho atual é `type: onnx` na imagem TensorRT.
- O preset de entrada é obrigatório quando a origem não é RTSP; sem ele, o Frigate tentou usar `rtsp_transport` em HTTP.

### Recomendação para o build real

1. Não adicionar Frigate permanentemente ao Compose ainda; a imagem GPU é grande e o worker ONNX/RTSP direto já atende o caminho de eventos estruturados.
2. Manter `yolo11n.onnx` em CPU como baseline de recall, mas não habilitar automações ainda: no conjunto estendido teve recall maior e precisão de 50% por causa dos hard negatives.
3. Manter o worker ONNX separado do VLM, com eventos somente quando houver evidência e confiança acima do limiar.
4. Usar a máscara/ROI candidata somente após validar mais posições; combinar com a confirmação temporal já implementada ou hard negatives adicionais antes de ajustar o limiar de produção.
5. Se a prioridade virar NVR, gravação, tracking ou dashboard de câmeras, usar Frigate como sidecar com CUDA; se a prioridade for somente eventos estruturados, manter o worker ONNX menor.
