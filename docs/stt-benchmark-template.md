# Benchmark de STT — template e resultado

## Como executar

```bash
npm run benchmark:stt -- --audio data/audio/tts/piper-smoke.wav
# Para WER/CER, use uma expectativa redigida:
npm run benchmark:stt -- --audio <fixture.wav> --expected "<frase redigida>"
```

O script executa o mesmo áudio contra Faster-Whisper local e, somente quando `GROQ_API_KEY` está presente no backend, contra:

- `whisper-large-v3-turbo`;
- `whisper-large-v3`.

A chave nunca é impressa. O áudio não é enviado à Groq quando a chave está ausente; o resultado informa `skipped`.

## Campos registrados

- provider/modelo e localização (`local`/`cloud`);
- latência do provider e wall-clock;
- duração quando retornada pelo provider;
- confiança somente quando a API fornece metadata;
- WER opcional contra uma expectativa não sensível;
- erro classificado/skip;
- bytes enviados e presença de chave apenas como booleano, nunca o valor.

## Resultado verificado em 2026-09-06

Fixture: `data/audio/tts/piper-smoke.wav` (áudio sintetizado pelo próprio Piper, 188.460 bytes). Não é uma amostra de fala humana; portanto este resultado **não é um gate de qualidade PT-BR real**.

```json
{
  "audioBytes": 188460,
  "expectedProvided": false,
  "results": [
    {
      "provider": "faster-whisper",
      "model": "medium",
      "processingLocation": "local",
      "latencyMs": 13358,
      "wallClockMs": 13358,
      "confidence": 0.697556234896183
    },
    {
      "provider": "groq",
      "skipped": true,
      "reason": "GROQ_API_KEY não configurada no backend"
    }
  ]
}
```

O texto retornado pela fixture foi omitido/redigido porque a amostra contém um nome. A execução confirmou que o local `medium` funciona, mas não permite comparar qualidade Groq nem validar fala espontânea.

## Interpretação

- O default permanece `route=local`, `cloudEnabled=false`.
- Groq não foi promovido nem cobrado nesta execução.
- Para decisão de promoção, repetir com várias frases PT-BR humanas autorizadas, expectativas redigidas e a mesma captura em ambos os providers; comparar p50/p95, WER e percepção de entendimento.
- O limite local de 10 s faturáveis e o custo estimado devem continuar sendo tratados como aproximações até confirmar os headers/console da organização.
