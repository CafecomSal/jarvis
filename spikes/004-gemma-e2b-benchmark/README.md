# Spike 004 — Gemma 4 E2B quantizado versus Gemma atual

## Pergunta

O `gemma4:e2b-it-q4_K_M` libera VRAM suficiente para o Jarvis sem perder tool calling e visão necessários ao Core?

## Protocolo

- Ollama local em `127.0.0.1:11434`.
- Core-compatible: `num_ctx=8192`, `temperature=0.2`, `stream=false`.
- Modelos testados sequencialmente:
  1. `gemma-hermes:latest` — Gemma 4 E4B Q4_0 usado atualmente.
  2. `gemma4:e2b-it-q4_K_M` — tag oficial do Ollama.
- Antes de cada modelo: `ollama stop` + confirmação de `/api/ps` vazio.
- Casos: resposta curta, tool calling read-only e interpretação de snapshot real da câmera.
- Segunda rodada: `think=false` e outro snapshot real.
- Ao final: ambos descarregados; nenhum modelo ficou residente na GPU.

Comando:

```bash
python spikes/004-gemma-e2b-benchmark/run_benchmark.py
```

## Resultados

| Dimensão | E4B atual | E2B Q4_K_M |
|---|---:|---:|
| `size_vram` reportado pelo Ollama | 3.090.436.586 bytes | 1.712.586.751 bytes |
| Uso efetivo médio adicional de GPU | 4.242 MiB | 2.929,5 MiB |
| Economia efetiva média | — | ~1.312,5 MiB (~30,9%) |
| Tool calls | 1/1 | 1/1 |
| Visão, rodada `think=false` | correta nos 2 frames | incorreta nos 2 frames |
| Visão, latência média nas duas rodadas | ~4.113 ms | ~2.426 ms |
| Texto, primeira rodada | 8.465 ms | 48.982 ms |
| Texto, segunda rodada `think=false` | 5.723 ms | 6.016 ms |

### Qualidade visual observada

- E4B descreveu corretamente a cena de rua e a pessoa em uma motocicleta.
- E2B descreveu os mesmos snapshots como formulário/tabela, tanto com raciocínio padrão quanto com `think=false`.
- O problema foi reproduzido em dois frames reais diferentes; não foi apenas uma medição de latência.

### Tool calling

Os dois modelos emitiram uma chamada para `get_home_state` no teste controlado. Isso indica compatibilidade básica de tool calling, mas não substitui a avaliação de respostas complexas do Jarvis.

Em uma validação adicional, o E2B foi carregado como `JARVIS_MODEL` no Core real e chamou `search_recordings`, retornando corretamente as duas gravações do intervalo solicitado. Portanto, o bloqueio do E2B é principalmente a qualidade visual observada, não a integração básica de tools.

### Memória e exclusividade GPU

- O E2B reduziu o uso efetivo adicional de GPU em aproximadamente `1.312,5 MiB` na média das duas rodadas.
- O E2B ficou em `~2,9 GiB` de uso efetivo adicional, deixando mais margem para outros processos.
- O benchmark carregou somente um modelo por vez e terminou com `/api/ps` vazio.
- Nenhum detector, Core ou worker foi iniciado durante a comparação.

## Verdict: PARTIAL

### O que funcionou

- O tag E2B foi encontrado, baixado e carregado pelo Ollama.
- A economia de VRAM foi real e relevante.
- Tool calling básico funcionou.
- Texto com `think=false` teve latência próxima à do E4B na segunda rodada.
- Visão do E2B respondeu, embora com interpretação errada.

### O que não funcionou

- A qualidade visual no cenário da câmera ficou inadequada: dois frames foram classificados como formulário/tabela.
- A primeira resposta curta do E2B ativou raciocínio padrão e levou aproximadamente 49 s.
- O resultado não justifica trocar o modelo padrão do Core.

## Recomendação para o build real

1. Manter `gemma-hermes:latest` como modelo padrão do Core.
2. Não carregar E4B e E2B simultaneamente na GPU.
3. Não manter o E2B como rota alternativa: a visão falhou no cenário da câmera e o tag `gemma4:e2b-it-q4_K_M` foi removido do Ollama após o benchmark.
4. Se o objetivo for liberar VRAM para visão, priorizar modelos de percepção separados em CPU e manter o E4B para VLM.
5. Novos candidatos de modelo só entram após benchmark multimodal com múltiplos snapshots e exclusividade GPU comprovada.

## Artefatos

- `run_benchmark.py`
- `results/gemma-e2b-vs-e4b-default-first-image.json`
- `results/gemma-e2b-vs-e4b-think-false-second-image.json`
