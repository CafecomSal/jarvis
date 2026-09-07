# Tags, importância e watch sessions

Tags são derivadas de eventos de objetos/OCR e mantêm:

- `evidenceEventId`;
- câmera/frame/recording quando disponível;
- confiança;
- origem (`detector`, `ocr`, `vlm`, `human`);
- status (`observed`, `confirmed`, `human_reviewed`, `identity`).

Exemplos de conteúdo: `object.class=car`, `object.color=prata`, `person.pose=sentada`, `relation=near:chair`.

A detecção original não é sobrescrita por revisão humana.

## Importância

O Gemma pode criar uma proposta de nível e justificativa. `ImportancePolicy` decide retenção/alerta de forma determinística; proposta de `critical` sozinha não protege um arquivo.

## Entregador

Uma watch session exige câmera/região, validade, pessoa, veículo compatível e aproximação. O sistema comunica possibilidade de chegada; não infere identidade facial.

## Ações

Propostas aparecem em `GET /actions/proposals`. Nesta fase não existem endpoints de confirmação ou execução. A política reserva confirmação secundária para risco crítico e mantém ações físicas bloqueadas.
