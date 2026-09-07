# Spike 006 — TTS PT-BR

## Baseline

`pt_BR-jeff-medium` do Piper foi baixado e sintetizado localmente no Windows. O wrapper TypeScript `PiperTtsProvider` usa `python -m piper` e retorna WAV.

## Fallback

`AzureTtsProvider` está implementado, mas só é criado com chave/região explícitas. `QuotaTtsProvider` aplica cache por texto/voz/mês e bloqueia quando a quota mensal é excedida. Nenhuma chamada cloud foi feita durante o benchmark.

## Critério de promoção

Comparar naturalidade PT-BR, latência, CPU/RAM, estabilidade e custo. Não usar GPU para áudio enquanto o baseline CPU for suficiente.
