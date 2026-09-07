# Spike 005 — áudio local

## Resultado verificado

- Faster-Whisper instalado e executado em CPU com modelo `base`.
- Piper instalado com voz `pt_BR-jeff-medium`.
- Pipeline HTTP real executado: STT → Gemma → TTS.
- Sessão concluída persistida no PostgreSQL sem áudio bruto.
- Nenhum modelo de áudio foi carregado na GPU.

## Limitações

A amostra usada foi voz sintetizada pelo Piper; ainda é necessário medir microfone real, ruído, latência p50/p95 e qualidade em fala espontânea.
