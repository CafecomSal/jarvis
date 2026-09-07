# STT Groq, Configuração da Dashboard e Limpeza de Sessões — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** reduzir a latência e melhorar a transcrição em português com um provider Groq controlado, tornar configurações operacionais seguras administráveis pela dashboard e permitir a exclusão explícita de sessões de áudio antigas sem apagar auditoria, gravações ou dados externos.

**Architecture:** manter `SttProvider` como fronteira provider-neutral e adicionar `GroqSttProvider` + `SttRouter`. O modo local continua sendo o default; Groq só é usado quando explicitamente habilitado, com quota local, timeout, fallback e indicação clara de que o áudio saiu da máquina. Configurações não sensíveis serão persistidas em uma store de runtime e aplicadas de forma serializada; credenciais continuam exclusivamente no backend/ambiente. Sessões de áudio serão apagadas por uma operação em duas fases (preview → confirmação), limitada a metadata/transcript persistidos, com auditoria da exclusão.

**Tech Stack:** Node.js 22, TypeScript/ESM, Fastify 5, React 19/Vite, Zod, PostgreSQL/`pg`, Vitest, `fetch`/`FormData` nativos do Node, Faster-Whisper CPU residente, Piper `pt_BR-jeff-medium`.

---

## 1. Preflight factual

### Estado ativo confirmado no código

| Componente | Estado atual | Evidência |
|---|---|---|
| STT local | Ativo quando `JARVIS_AUDIO_ENABLED=true`; Faster-Whisper `medium`, CPU `int8`, worker Python residente | `src/server.ts`, `src/audio/providers/faster-whisper-stt.ts`, `scripts/faster_whisper_worker.py` |
| TTS | Piper local CPU, voz `pt_BR-jeff-medium`; deve permanecer intacto | `src/server.ts`, `src/audio/providers/piper-tts.ts` |
| Pipeline | `STT → ConversationOrchestrator/Gemma → TTS`; só persiste transcript/metadata | `src/audio/audio-pipeline.ts` |
| Contrato STT | Apenas `transcribe(audio, mimeType)`; sem roteamento, quota ou localização explícita | `src/audio/stt-provider.ts` |
| Configuração | Lida de `process.env` no boot; sem store de runtime | `src/server.ts` |
| Dashboard | Aba Configurações read-only; Áudio lista as últimas 20 sessões e permite push-to-talk | `web/src/App.tsx` |
| Sessões | `append`, `list`, `findById`; não há `delete` nem preview de impacto | `src/audio/audio-types.ts`, `src/audio/audio-session-store.ts` |
| Banco | `audio_sessions` possui transcript JSONB e metadata, sem áudio bruto | `infrastructure/postgres/003_audio_sessions.sql` |
| Auditoria | `conversation`, `tool_call`, `policy_decision`; já há store em memória/PostgreSQL | `src/audit/schema.ts`, `src/audit/*` |
| GPU | Gemma é o único modelo destinado à GPU; STT/TTS devem continuar em CPU | health/runtime e documentação existentes |

### Estado observado no runtime

Consulta read-only em `GET /audio/sessions?limit=100` retornou:

- 22 sessões persistidas;
- 11 `completed` e 11 `failed`;
- 11 com transcript `faster-whisper` e 11 sem transcript, correspondentes às falhas;
- nenhum campo `rawAudio` ou `audioBase64` nas sessões;
- sessões mais antigas e mais novas ainda pertencem à janela atual de execução, portanto não será feita exclusão automática agora.

### Fatos atuais da Groq

Consultados na documentação oficial em 2026-09-05; revalidar os valores durante a implementação porque preços e limites podem mudar:

- Endpoint síncrono: `POST https://api.groq.com/openai/v1/audio/transcriptions`.
- Modelos de STT multilíngue atualmente listados: `whisper-large-v3` e `whisper-large-v3-turbo`.
- `whisper-large-v3-turbo` é o candidato recomendado para baixa latência/preço; a página oficial lista `$0.04/h`.
- `whisper-large-v3` é o candidato recomendado quando precisão pesa mais que velocidade; a página oficial lista `$0.111/h`.
- O modelo `distil-whisper-large-v3-en` é inglês-only e não deve ser usado para PT-BR.
- Formatos aceitos incluem `flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `wav` e `webm`; o browser atual já produz `webm`/`ogg`.
- Limite documentado: 25 MB no free tier e 100 MB no dev tier; o limite atual do Jarvis é menor e deve continuar sendo aplicado.
- Comprimento mínimo faturado: 10 segundos, mesmo quando o áudio enviado é menor.
- A Groq faz downsample para 16 kHz mono; a documentação recomenda WAV para menor latência quando a conversão for viável.
- `response_format` pode ser `json`, `verbose_json` ou `text`; `verbose_json` será usado para obter duração/segmentos/indicadores quando disponíveis.
- `language`, `temperature` e `prompt` são parâmetros disponíveis; o prompt tem limite documentado de 224 tokens.
- Limites são por organização e podem ser observados nos headers `x-ratelimit-*`; o Jarvis não deve assumir que os limites do plano publicado são os limites da conta.

Fontes:

- https://console.groq.com/docs/speech-to-text
- https://console.groq.com/docs/model/whisper-large-v3-turbo
- https://console.groq.com/docs/model/whisper-large-v3
- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/api-reference

---

## 2. Decisões recomendadas antes da execução

Estas decisões devem ser confirmadas antes de implementar/ativar cloud. O plano não ativa provider, não instala credencial e não envia áudio para a Groq.

1. **Rota recomendada:** manter `local` como default atual; oferecer `groq` e `auto` na dashboard. Para uso interativo, promover `whisper-large-v3-turbo` como primeira opção Groq; em `auto`, Groq é tentado somente se cloud estiver habilitado e dentro da quota, com fallback local.
2. **Fallback recomendado:** fallback para local apenas em indisponibilidade/timeout/429/5xx ou bloqueio da quota cloud. Não repetir cegamente uma requisição Groq que pode ter sido aceita; evitar cobrança duplicada. Erros de credencial, formato ou payload inválido devem aparecer como erro de configuração, não gerar retries infinitos.
3. **Privacidade recomendada:** `cloudEnabled=false` e `route=local` por padrão. Ao habilitar Groq, a UI precisa mostrar que o áudio será enviado para processamento externo e exigir confirmação explícita. A chave nunca aparece no frontend nem em logs, sessões, auditoria ou documentação.
4. **Quota recomendada:** exigir limites locais antes de habilitar cloud: requests/dia, segundos/dia e, opcionalmente, teto mensal estimado. A conta Groq não será tratada como tendo automaticamente “1k por modelo”: os limites são específicos da organização/plano e devem ser conferidos no console e nos headers reais. O Jarvis usará uma única credencial/organização ativa, mostrará o uso observado e permitirá ajustar um teto local conservador. Não será implementado rodízio automático de 2–3 contas para multiplicar quota.
5. **Sessões recomendadas:** conforme a decisão do usuário, a operação abrange a sessão de áudio e o conteúdo da conversa exatamente vinculada por `conversationId`. A auditoria não será apagada: seus campos de conteúdo serão redigidos e a linha estrutural/tombstone será preservada para segurança. Não entram sessões não vinculadas, `watch-sessions`, gravações, snapshots ou Drive. O default é exclusão manual de `completed`/`failed` anteriores a 30 dias; auto-retenção fica desligada até opt-in explícito.
6. **TTS:** Piper `pt_BR-jeff-medium` permanece provider/modelo efetivo e não será trocado nesta fase. A dashboard pode exibi-lo e configurar destino seguro se necessário, mas não deve alterar o modelo sem uma decisão separada.
7. **GPU e processos:** nenhum STT cloud ou local será carregado na GPU. Troca de modelo local deve fechar o worker anterior antes de iniciar outro; nunca haverá dois workers STT locais residentes por causa de uma mudança na dashboard.

### Decisões capturadas na rodada de definição

- Rota escolhida: **Groq como principal quando o cloud estiver explicitamente habilitado, com fallback local**.
- Escopo escolhido: **sessão de áudio + conteúdo da conversa vinculada por `conversationId`**.
- Quota: usar a faixa gratuita disponível na organização configurada, mas sem presumir `1k por modelo` e sem somar contas. Os limites reais serão confirmados no console/headers; o Jarvis impõe um teto local separado.
- Política de auditoria confirmada: **redigir conteúdo e manter metadados/tombstone**, sem apagar fisicamente as linhas do audit log.

### Itens explicitamente fora deste plano

- criação de skill AWS ou uso da Alexa como microfone LAN;
- autostart, Task Scheduler, novo daemon persistente ou publicação automática;
- exclusão de arquivos reais do Google Drive;
- exclusão de gravações/snapshots junto com uma sessão de áudio;
- pool/rodízio automático de chaves ou contas Groq para contornar limites;
- ações físicas, Face ID ou mudança da política de propostas;
- exposição do Core fora de `127.0.0.1`/Tailscale Serve tailnet-only;
- permitir que o frontend escolha URL arbitrária, modelo arbitrário, `DATABASE_URL`, RTSP ou caminho de arquivo.

---

## 3. Plano de implementação por fatias verticais

### Task 1: Formalizar o contrato de configuração e resultado de STT

**Objective:** tornar provider, rota local/cloud, modelo, idioma, latência e fallback representáveis sem quebrar sessões existentes.

**Files:**
- Modify: `src/audio/stt-provider.ts`
- Modify: `src/audio/audio-types.ts`
- Create: `src/audio/stt-config.ts`
- Test: `tests/audio-providers.test.ts`
- Create: `tests/stt-config.test.ts`

**Step 1: Write failing tests**

Cobrir:

- `route` aceita somente `local`, `groq`, `auto`;
- modelos Groq aceitos são apenas `whisper-large-v3` e `whisper-large-v3-turbo`;
- idioma default é `pt-BR`/`pt` normalizado;
- uma transcrição pode carregar `processingLocation: 'local' | 'cloud'` e `fallbackFrom` opcional;
- dados antigos sem esses campos continuam válidos;
- nenhum campo de chave/token pertence ao schema de transcript ou sessão.

**Step 2: Run RED**

```bash
npx vitest run tests/stt-config.test.ts tests/audio-providers.test.ts
```

Esperado: falha porque os tipos/schema ainda não possuem o contrato novo.

**Step 3: Minimal GREEN implementation**

Adicionar schemas pequenos e provider-neutral. Não colocar lógica Groq no pipeline e não alterar o provider Piper.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/stt-config.test.ts tests/audio-providers.test.ts
```

**Acceptance:** resultados antigos continuam parseando; a origem local/cloud fica disponível apenas como metadata segura.

---

### Task 2: Implementar `GroqSttProvider` sem expor segredo

**Objective:** adicionar transcrição Groq síncrona usando o endpoint oficial, sem adicionar SDK se `fetch`/`FormData` nativos do Node 22 forem suficientes.

**Files:**
- Create: `src/audio/providers/groq-stt.ts`
- Modify: `src/audio/stt-provider.ts` se o contrato exigir opções explícitas
- Create: `tests/groq-stt.test.ts`

**Step 1: Write failing tests**

Usar `fetchImpl` injetado, nunca a rede real, para verificar:

- método `POST` e endpoint configurável, com default oficial;
- `Authorization: Bearer <secret>` usado apenas no backend;
- multipart contém `file`, `model`, `language=pt`, `response_format=verbose_json`, `temperature=0`;
- `webm`, `ogg` e `wav` preservam MIME permitido;
- texto e idioma retornam normalizados;
- confiança só é preenchida quando metadata suficiente existir; não inventar confiança;
- timeout aborta a requisição;
- 401/403, 413, 429 e 5xx produzem erros classificados sem incluir chave, áudio ou corpo sensível;
- resposta JSON inválida e transcript vazio falham honestamente.

**Step 2: Run RED**

```bash
npx vitest run tests/groq-stt.test.ts
```

Esperado: módulo/provider ausente.

**Step 3: Minimal GREEN implementation**

Implementar `GroqSttProvider` com:

```text
POST /openai/v1/audio/transcriptions
file=<Blob/arquivo temporário em memória>
model=<allowlist>
language=pt
temperature=0
response_format=verbose_json
```

Usar `AbortController`, limite de payload já imposto pelo Core, e captura dos headers de rate limit apenas para observabilidade. Não persistir arquivo bruto. Não fazer retry automático de uma requisição cujo resultado seja ambíguo.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/groq-stt.test.ts
```

**Acceptance:** provider funciona com mock determinístico e todos os erros não contêm segredo. Sem `GROQ_API_KEY`, a composição não cria o provider cloud.

---

### Task 3: Criar `SttRouter` com fallback e classificação de falhas

**Objective:** escolher local/Groq conforme configuração e usar fallback somente nas condições autorizadas.

**Files:**
- Create: `src/audio/stt-router.ts`
- Create: `tests/stt-router.test.ts`
- Modify: `src/audio/audio-pipeline.ts` apenas se necessário para metadata

**Step 1: Write failing tests**

Casos mínimos:

1. `route=local` chama somente Faster-Whisper.
2. `route=groq` com cloud desligado não envia áudio e retorna erro de configuração ou usa local somente se `fallback=local` estiver explicitamente configurado.
3. `route=auto` chama Groq quando habilitado e dentro da quota.
4. timeout/429/5xx de Groq com fallback habilitado chama local uma vez.
5. 401/403/invalid payload não faz retry/fallback silencioso.
6. falha local não chama Groq retroativamente sem rota `auto` autorizada.
7. transcript registra provider efetivo e motivo de fallback, sem áudio.

**Step 2: Run RED**

```bash
npx vitest run tests/stt-router.test.ts
```

Esperado: `SttRouter` inexistente.

**Step 3: Minimal GREEN implementation**

Implementar roteamento serializado, com uma única tentativa por provider e classificação de erro (`configuration`, `quota`, `timeout`, `upstream`, `invalid_input`). A política deve ser determinística e independente do Gemma.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/stt-router.test.ts tests/audio-pipeline.test.ts
```

**Acceptance:** o pipeline continua `STT → Gemma → Piper`; o TTS é chamado exatamente como antes.

---

### Task 4: Implementar quota local e uso cloud observável

**Objective:** impedir que a dashboard habilite cloud sem teto local e registrar consumo sem depender apenas dos limites externos da Groq.

**Files:**
- Create: `src/audio/stt-usage-store.ts`
- Create: `src/audio/audio-duration-probe.ts`
- Create: `infrastructure/postgres/004_runtime_settings.sql`
- Create: `tests/stt-usage.test.ts`
- Create: `tests/audio-duration-probe.test.ts`

**Step 1: Write failing tests**

Verificar:

- requests/dia e segundos/dia bloqueiam antes de chamar Groq;
- quota é calculada por data UTC consistente;
- não existe seleção automática de outra chave/organização quando a quota acaba;
- áudio sem duração verificável não ultrapassa a política cloud;
- `remaining` nunca fica negativo;
- atualização idempotente não conta duas vezes o mesmo `sessionId`;
- store em memória e PostgreSQL têm a mesma semântica.

**Step 2: Run RED**

```bash
npx vitest run tests/stt-usage.test.ts tests/audio-duration-probe.test.ts
```

**Step 3: Minimal GREEN implementation**

Adicionar uma store diária com `session_id` único, requests, segundos, estimativa e headers observados. Para o limite pré-request, usar duração medida por um `AudioDurationProbe` bounded; se a medição não for possível, bloquear cloud ou seguir para local conforme fallback explícito. Respeitar o limite Jarvis atual de 10 MB antes de considerar os limites maiores da Groq. A implementação terá uma única credencial/organização ativa; a ideia de somar a cota free de duas ou três contas não será automatizada. O teto local inicial permanece conservador e editável até os limites reais da organização serem confirmados no console.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/stt-usage.test.ts tests/audio-duration-probe.test.ts
```

**Acceptance:** quota local é fail-closed para cloud, mas não impede o provider local quando este for a rota configurada.

---

### Task 5: Criar store de runtime settings com defaults seguros

**Objective:** persistir somente configurações não sensíveis e permitir aplicar mudanças sem editar `.env` manualmente.

**Files:**
- Create: `src/config/runtime-settings.ts`
- Create: `src/config/runtime-settings-store.ts`
- Modify: `infrastructure/postgres/004_runtime_settings.sql`
- Create: `tests/runtime-settings.test.ts`
- Create: `tests/runtime-settings-store.test.ts`

**Step 1: Write failing tests**

Defaults esperados:

```json
{
  "audioEnabled": false,
  "stt": {
    "route": "local",
    "localModel": "medium",
    "groqModel": "whisper-large-v3-turbo",
    "language": "pt-BR",
    "fallback": "none",
    "timeoutMs": 12000,
    "cloudEnabled": false
  },
  "quota": {
    "maxRequestsPerDay": 30,
    "maxAudioSecondsPerDay": 600,
    "maxEstimatedMonthlyUsd": 1
  },
  "audioSessions": {
    "autoDeleteEnabled": false,
    "retentionDays": 30,
    "deletableStatuses": ["completed", "failed"]
  }
}
```

Esses valores são somente defaults conservadores do **guard local**, não uma afirmação sobre a cota free da Groq. Testar validação de limites, allowlists, merge parcial, versão de schema e que campos como `GROQ_API_KEY`, `DATABASE_URL`, RTSP, token Tailscale e caminhos absolutos não são aceitos.

**Step 2: Run RED**

```bash
npx vitest run tests/runtime-settings.test.ts tests/runtime-settings-store.test.ts
```

**Step 3: Minimal GREEN implementation**

Criar store em memória para testes e PostgreSQL para runtime persistente. As linhas devem guardar somente JSON de settings validado, versão e `updated_at`. O valor efetivo deve ser `DB override → env não sensível → default seguro`; o segredo Groq continua vindo somente de `GROQ_API_KEY` no processo.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/runtime-settings.test.ts tests/runtime-settings-store.test.ts
```

**Acceptance:** reinício preserva configuração não sensível; remover override retorna ao default/env; nenhuma leitura de settings devolve segredo.

---

### Task 6: Compor runtime de áudio com hot-swap seguro e health detalhado

**Objective:** aplicar mudanças de provider/modelo pela dashboard sem deixar workers antigos ativos e sem modificar Piper.

**Files:**
- Create: `src/audio/audio-runtime.ts`
- Modify: `src/server.ts`
- Modify: `src/app.ts`
- Modify: `src/health/system-health.ts`
- Modify: `src/health/runtime-health.ts`
- Create: `tests/audio-runtime.test.ts`
- Modify: `tests/system-health.test.ts`

**Step 1: Write failing tests**

Testar:

- apenas um provider local/worker é ativo por vez;
- mudar `medium → small` fecha o worker anterior antes de iniciar o novo;
- mudar local → Groq não cria worker local adicional;
- falha na aplicação mantém o provider anterior e marca erro, sem deixar estado parcialmente aplicado;
- `close()` encerra o worker residente;
- Piper continua apontando para `pt_BR-jeff-medium`.

**Step 2: Run RED**

```bash
npx vitest run tests/audio-runtime.test.ts tests/system-health.test.ts
```

**Step 3: Minimal GREEN implementation**

Extrair a composição atual para um runtime com lock/queue de aplicação. O pipeline recebe uma referência ao router atual, não uma chave fixa construída somente no boot. A troca deve ser bounded; se não puder ser hot-swapped com segurança, retornar `restartRequired=true` em vez de alegar aplicação imediata.

Health deve expor, sem segredos:

```json
{
  "audio": {
    "status": "configured",
    "stt": {
      "route": "local|groq|auto",
      "activeProvider": "faster-whisper|groq",
      "model": "[model]",
      "processingLocation": "local|cloud",
      "fallback": "none|local",
      "cloudConfigured": false,
      "quota": { "remainingRequests": 0, "remainingSeconds": 0 }
    },
    "tts": { "provider": "piper", "model": "pt_BR-jeff-medium" }
  }
}
```

**Step 4: Verify GREEN**

```bash
npx vitest run tests/audio-runtime.test.ts tests/system-health.test.ts
```

**Acceptance:** health distingue local/cloud; nenhum valor de `GROQ_API_KEY`, URL autenticada ou áudio aparece.

---

### Task 7: Adicionar API segura de configurações

**Objective:** expor leitura redigida e atualização validada de configurações pela dashboard.

**Files:**
- Modify: `src/app.ts`
- Create: `tests/settings-api.test.ts`
- Modify: `src/audit/audit-utils.ts` se necessário
- Modify: `src/audit/schema.ts` apenas se um tipo de auditoria novo for indispensável

**Step 1: Write failing tests**

Rotas propostas:

```text
GET  /settings
PUT  /settings
```

Testar:

- `GET` retorna effective settings, `source` (`default`, `env`, `database`), status de segredo configurado/não configurado e uso de quota, nunca o segredo;
- `PUT` aceita somente campos allowlisted e rejeita números fora do limite, modelos desconhecidos e campos sensíveis;
- habilitar cloud sem `GROQ_API_KEY` retorna `400`/`409` e não altera configuração;
- habilitar cloud exige confirmação explícita no payload (`confirmCloudBoundary: true`);
- mudança de provider/modelo gera auditoria redigida com actor `dashboard`;
- falha de aplicação retorna configuração anterior e erro claro;
- root endpoint passa a documentar as rotas novas sem listar segredos.

**Step 2: Run RED**

```bash
npx vitest run tests/settings-api.test.ts
```

**Step 3: Minimal GREEN implementation**

Usar schemas Zod separados para leitura e escrita. Nunca aceitar `GROQ_API_KEY` no body comum. A configuração da chave permanece em ambiente seguro do backend; a dashboard só vê `configured: true/false`. Toda mudança deve ser auditada com old/new redigidos, sem transcript.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/settings-api.test.ts tests/audit.test.ts
```

**Acceptance:** a API permite administrar comportamento, mas não infraestrutura perigosa, credenciais ou ações físicas.

---

### Task 8: Implementar preview, exclusão e readback de sessões de áudio

**Objective:** excluir sessões antigas permitidas e redigir o conteúdo da conversa vinculada, com confirmação explícita e trilha de auditoria preservada.

**Files:**
- Modify: `src/audio/audio-types.ts`
- Modify: `src/audio/audio-session-store.ts`
- Create: `src/audio/audio-session-retention.ts`
- Modify: `infrastructure/postgres/004_runtime_settings.sql` se forem necessários índices
- Modify: `src/app.ts`
- Create: `tests/audio-session-retention.test.ts`
- Modify: `tests/audio-api.test.ts`
- Create: `tests/postgres-audio-session-store.test.ts` para o caminho PostgreSQL quando disponível

**Step 1: Write failing tests**

Contrato recomendado:

```text
POST   /audio/sessions/delete-preview
DELETE /audio/sessions
```

Payload de preview/exclusão:

```json
{
  "before": "2026-08-01T00:00:00.000Z",
  "statuses": ["completed", "failed"],
  "ids": []
}
```

Testar:

- preview retorna count, intervalo, contagem por status e IDs/metadata necessários para confirmação, sem áudio bruto;
- somente `completed` e `failed` são deletáveis por bulk;
- `recording`, `transcribing`, `responding` e `speaking` nunca entram;
- exclusão exige `previewId`/nonce de curta duração ou confirmação equivalente ligada exatamente ao preview;
- preview expirado, alterado ou reutilizado falha sem apagar;
- exclusão idempotente retorna `deleted=0` na repetição;
- store em memória e PostgreSQL removem os mesmos registros;
- para cada sessão com `conversationId`, o conteúdo da conversa exatamente vinculada é redigido (`message`, `modelAnswer`, `answer`, argumentos/resultados de tools e demais payloads de conteúdo), mantendo `conversationId`, timestamp, kind, actor, outcome e um tombstone de exclusão;
- auditoria registra quantidade, critérios, actor e IDs redigidos/limitados, mas não conserva o transcript/resposta em texto após a purga;
- linhas de auditoria não são apagadas: `/audit` continua provando que houve uma conversa e uma exclusão, sem expor o conteúdo redigido; eventos, recordings e Drive não são apagados em cascata;
- após a resposta, `findById`/listagem confirmam que os IDs não existem.

**Step 2: Run RED**

```bash
npx vitest run tests/audio-session-retention.test.ts tests/audio-api.test.ts
```

Esperado: ausência de método/rotas de exclusão.

**Step 3: Minimal GREEN implementation**

Adicionar `previewDelete` e `delete` ao contrato da store, com queries parametrizadas. O serviço de retenção deve:

1. validar `before` e status allowlist;
2. resolver somente os `conversationId` pertencentes às sessões selecionadas;
3. redigir o conteúdo das linhas de auditoria desses IDs, sem atingir conversas não vinculadas;
4. excluir as linhas selecionadas de `audio_sessions`;
5. registrar tombstone/auditoria da operação;
6. usar transação quando a confirmação, redaction e deleção dependerem do mesmo preview;
7. retornar resultado verificável.

Não procurar nem apagar arquivos fora de uma lista explícita de artefatos de áudio; hoje não há áudio bruto persistido. Exclusão física de linhas de auditoria continua fora do plano e exigiria uma decisão separada por destruir o trilho de segurança.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/audio-session-retention.test.ts tests/audio-api.test.ts tests/postgres-audio-session-store.test.ts
```

**Acceptance:** nenhuma exclusão acontece sem preview + confirmação; o readback prova remoção somente das sessões selecionadas.

---

### Task 9: Adicionar gerenciamento de provider e sessões à dashboard

**Objective:** tornar o uso operável por UI, com indicação visual de local/cloud e confirmação de destruição.

**Files:**
- Modify: `web/src/api/client.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/app-model.ts`
- Modify: `web/src/styles/app.css`
- Create: `tests/web-settings-client.test.ts`
- Create: `tests/web-audio-session-actions.test.ts`

**Step 1: Write failing tests**

Cobrir helpers puros para:

- separar settings editáveis de redigidos;
- mostrar `local`/`cloud` corretamente;
- bloquear salvar `groq` sem confirmação;
- gerar payload de preview sem transcript/audio;
- exigir frase de confirmação com count exato;
- remover somente as sessões retornadas no readback.

**Step 2: Run RED**

```bash
npx vitest run tests/web-settings-client.test.ts tests/web-audio-session-actions.test.ts
```

**Step 3: Minimal GREEN implementation**

Na aba **Configurações**, adicionar cartões:

- **STT:** rota `Local / Groq / Automático`, modelo conforme allowlist, idioma PT-BR, timeout, fallback;
- **Cloud:** habilitado/desabilitado, `API key configurada/não configurada`, aviso de saída de áudio, quota usada/restante; nunca campo de segredo;
- **Sessões:** retenção sugerida, auto-delete desligado por padrão, status permitidos;
- **TTS:** Piper `pt_BR-jeff-medium` visível como protegido/não alterado;
- **Segurança:** GPU máximo de um modelo, Core loopback, Tailscale-only, ações físicas bloqueadas, todos read-only.

Na aba **Áudio**:

- badge `LOCAL · faster-whisper` ou `CLOUD · Groq` por sessão;
- provider/modelo/latência/fallback visíveis;
- filtros por status/data;
- botão **Pré-visualizar exclusão**;
- modal com quantidade, período, statuses e aviso de que transcript/resposta serão removidos;
- confirmação digitada com a contagem exata;
- refresh após readback e erro explícito se alguma sessão permanecer.

O `deviceId` do microfone continua não persistido; a preferência física atual permanece apenas política de seleção no browser.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/web-settings-client.test.ts tests/web-audio-session-actions.test.ts tests/web-navigation.test.ts
npm run build:web
```

**Acceptance:** um usuário consegue configurar rota/quota/retenção, entende quando cloud está ativo e não consegue apagar sessões sem confirmação explícita.

---

### Task 10: Implementar retenção automática somente como opt-in

**Objective:** permitir que a política configurada pela dashboard seja aplicada sem transformar uma configuração em apagamento inesperado.

**Files:**
- Create: `src/audio/audio-session-retention-scheduler.ts`
- Modify: `src/server.ts`
- Create: `tests/audio-session-retention-scheduler.test.ts`

**Step 1: Write failing tests**

- scheduler não inicia quando `autoDeleteEnabled=false`;
- quando habilitado, usa `retentionDays` e statuses allowlist;
- nunca exclui sessão ativa;
- cada execução cria auditoria agregada e é idempotente;
- erro não interrompe o Core e não apaga parcialmente fora da transação;
- shutdown encerra scheduler.

**Step 2: Run RED**

```bash
npx vitest run tests/audio-session-retention-scheduler.test.ts
```

**Step 3: Minimal GREEN implementation**

Scheduler diário bounded, sem apagar gravações/snapshots/Drive. O default permanece desligado. A UI deve separar claramente “manual agora” de “limpeza automática habilitada”. Se a arquitetura atual não permitir aplicar essa configuração sem reinício seguro, informar `restartRequired` em vez de criar um worker duplicado.

**Step 4: Verify GREEN**

```bash
npx vitest run tests/audio-session-retention-scheduler.test.ts tests/audio-session-retention.test.ts
```

**Acceptance:** só existe limpeza automática após opt-in explícito e readback/auditoria de cada execução.

---

### Task 11: Benchmarkar local vs Groq antes de promover o default

**Objective:** provar qualidade e latência com o mesmo áudio antes de escolher a rota de produção.

**Files:**
- Create: `scripts/benchmark-stt.ts` ou `scripts/benchmark-stt.py` conforme o harness escolhido
- Create: `docs/stt-benchmark-template.md`
- Modify: `.env.example` somente com nomes/defaults não sensíveis
- Do not commit: áudio humano bruto, chave Groq, payload base64 ou transcript pessoal não redigido

**Step 1: Prepare a bounded fixture**

Usar frases PT-BR curtas e uma captura Fifine autorizada. O arquivo de áudio fica somente em diretório temporário e é removido ao final. Repetir o mesmo áudio nos candidatos:

- Faster-Whisper `medium` residente CPU;
- Groq `whisper-large-v3-turbo`;
- Groq `whisper-large-v3`.

Não testar `distil-whisper-large-v3-en` para PT-BR.

**Step 2: Measure**

Registrar apenas métricas necessárias:

- tempo de captura, upload, provider e pipeline total;
- transcrição esperada e WER/CER por frase, com dados pessoais redigidos;
- confiança/metadata somente quando o provider realmente retornar;
- status, erro classificado, tamanho enviado e duração;
- uso/quota e custo estimado com a ressalva do mínimo faturado de 10 s.

**Step 3: Run**

```bash
npm run build
# benchmark local separado
# benchmark Groq somente depois de chave configurada no backend e confirmação explícita de envio de áudio
```

**Step 4: Decision gate**

Promover Groq apenas se superar o local em latência e qualidade percebida nas frases reais. Caso contrário, manter `route=local` e deixar Groq como opção experimental. Não trocar o default por uma única frase feliz.

**Acceptance:** o relatório diz qual provider foi carregado/usado, localização do processamento, latência, limitações, custo estimado e se qualquer áudio temporário foi removido.

---

### Task 12: Documentar, verificar e preparar rollback

**Objective:** fechar a mudança com documentação honesta, testes completos e reversão simples.

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/audio-architecture.md`
- Modify: `docs/web-interface.md`
- Modify: `JARVIS_AI_MAP.md`
- Modify: `.hermes/plans/2026-09-05_215145-stt-groq-dashboard-sessoes.md` com resultados reais

**Documentar variáveis não sensíveis:**

```text
JARVIS_AUDIO_ENABLED=false
JARVIS_STT_ROUTE=local
JARVIS_STT_MODEL=medium
JARVIS_STT_LANGUAGE=pt-BR
JARVIS_STT_FALLBACK=none
JARVIS_STT_TIMEOUT_MS=12000
JARVIS_CLOUD_STT_ENABLED=false
JARVIS_GROQ_STT_MODEL=whisper-large-v3-turbo
JARVIS_STT_MAX_REQUESTS_PER_DAY=30
JARVIS_STT_MAX_AUDIO_SECONDS_PER_DAY=600
JARVIS_AUDIO_SESSION_AUTO_DELETE=false
JARVIS_AUDIO_SESSION_RETENTION_DAYS=30
```

A documentação deve dizer explicitamente que `GROQ_API_KEY` existe apenas no ambiente seguro do backend, sem mostrar valor ou exemplo de token.

**Verification sequence:**

1. focused tests de provider/router/quota/settings/delete/UI;
2. `npm test` completo;
3. `npm run build` completo;
4. health local em `127.0.0.1:3000`;
5. `GET /settings` sem segredo;
6. smoke local com áudio conhecido e Piper intacto;
7. smoke Groq somente com autorização e chave já configurada, se o usuário decidir ativá-lo;
8. preview/delete de uma sessão de fixture e readback `404`/lista sem o ID;
9. readback de auditoria da exclusão;
10. confirmar que não há `rawAudio`, `audioBase64`, chave, URL autenticada ou arquivo temporário persistido;
11. confirmar `ollama`/GPU e que não há mais de um modelo neural GPU;
12. confirmar que workers locais antigos e scheduler/testes temporários foram encerrados quando não explicitamente solicitados.

**Rollback:**

- colocar `cloudEnabled=false`, `route=local`, `fallback=none` pela dashboard ou remover o override de runtime;
- manter `JARVIS_STT_MODEL=medium` como fallback local;
- preservar Piper sem alteração;
- remover somente overrides da tabela de settings, sem apagar histórico de auditoria;
- a migration é aditiva; não remover colunas/linhas de produção durante rollback;
- desabilitar `autoDeleteEnabled` antes de qualquer rollback de retenção.

**Acceptance:** full suite/build passam, health e settings refletem o estado efetivo, e cada side effect cloud/deleção tem confirmação e readback verificável.

---

## 4. Matriz de riscos e mitigação

| Risco | Mitigação |
|---|---|
| Groq melhora latência mas piora uma frase específica | benchmark com várias frases PT-BR e decisão por qualidade + latência, não por uma única confiança |
| áudio vaza por configuração acidental | cloud desligado por default, confirmação explícita, chave backend-only, badge cloud e auditoria redigida |
| quota da Groq muda ou diverge do plano | quota local persistente + leitura de headers `x-ratelimit-*` + valores externos tratados como informativos |
| timeout depois de a Groq aceitar a requisição | não retryar cegamente; classificar resultado ambíguo e usar fallback somente uma vez quando autorizado |
| troca de modelo deixa dois workers | runtime serializado, `close()` do worker anterior e teste de exclusividade |
| exclusão apagar contexto útil | preview obrigatório, statuses allowlist, confirmação com count, sem cascade para audit/conversation/recording/Drive |
| auto-delete inesperado | default off, retenção separada de exclusão manual e auditoria por execução |
| TTS regressar durante a mudança | Piper fora do escopo de troca; teste de provider/modelo antes e depois |
| dashboard escrever infraestrutura perigosa | schemas allowlist; não expor DB, RTSP, Tailscale, GPU, paths ou actions físicas |
| PostgreSQL indisponível em testes | stores em memória cobertas; teste PostgreSQL marcado conforme o padrão atual e reportado sem mascarar falha |

---

## 5. Resultados reais da execução — 2026-09-07

### Implementado

- `GroqSttProvider` com `fetch`/`FormData` nativos, allowlist de modelos, timeout, classificação de 401/403/413/429/5xx, transcript verbose e headers `x-ratelimit-*` seguros.
- `SttRouter` com `local`/`groq`/`auto`, fallback local somente para timeout/upstream/quota autorizados e sem retry cego.
- `AudioRuntime` com aplicação serializada, fila exclusiva, fechamento do provider antigo antes de criar o próximo e restauração após falha.
- Configuração persistente allowlisted para STT, quota, `audioEnabled` e retenção; `GROQ_API_KEY` não pertence ao schema nem ao payload da dashboard.
- Quota local com requests/segundos por dia, custo estimado acumulado por mês UTC, mínimo faturável de 10 s e idempotência por `sessionId`.
- Limpeza manual `preview → confirmação exata → delete bounded`, revalidação de `id + status + startedAt`, redaction da auditoria vinculada e tombstone preservado.
- Scheduler de retenção automática opt-in, desligado por default.
- Dashboard com modelo Groq/idioma/timeout/quota/retenção, estado cloud, TTS Piper protegido e gerenciamento de sessões; a UI não oferece mais Local/Automático, Faster-Whisper ou fallback local.
- Cliente web com timeout próprio de 180 s para o pipeline completo; APIs comuns permanecem em 30 s.
- Duração informada pelo browser no `POST /audio/pc`, com fallback RIFF bounded para WAV não seekable, evitando falso bloqueio de quota.
- Piper real resolvido pelo executável `piper` do PATH ou `PIPER_COMMAND`, sem forçar o Python do runtime Hermes.
- Fallback de resolução de migrations para boot compilado em `dist/`.

### Evidências verificadas

- Focadas: provider/router/runtime/quota/retenção/UI verdes.
- Suíte final: **110 arquivos passados, 3 pulados; 282 testes passados e 3 pulados** em worker único; o modo paralelo apresentou OOM do worker, sem falha de asserção.
- Testes PostgreSQL executados explicitamente com `node --env-file=.env`: `PostgresAudioSessionStore` e `PostgresSttUsageStore` passaram; os fixtures foram limpos ao final (`test-pg-audio-session-001` e `test-pg-stt-usage-001-*`).
- `npm run build` passou; `npm start` em porta isolada `3001` iniciou a partir de `dist/` e foi encerrado após o smoke.
- Core real: `/system/health` `ok`; `ollama.loadedModels=[gemma-hermes:latest]`; GPU com um único modelo neural; `ffmpeg.exe=0`; bind loopback e exposição `tailscale-only`.
- Core real: `GET /settings` e `/system/health` confirmaram `route=groq`, `groqModel=whisper-large-v3-turbo`, `fallback=none`, `cloudEnabled=true`, provider ativo Groq, Piper CPU e nenhum segredo.
- Core real: preview de retenção antes de 2026-08-07 retornou `count=0`, sem transcript/response no payload; nenhuma sessão real foi apagada.
- Benchmark live com a mesma fixture sintetizada Piper de 188.460 bytes: `whisper-large-v3-turbo` em 534 ms, confiança 0,6405; `whisper-large-v3` em 480 ms, confiança 0,6094. Nenhum transcript pessoal foi incluído no relatório.
- Piper real: executável `piper` gerou WAV de 130.092 bytes em 2.135 ms.
- Smoke integrado definitivo após o último restart: sessão `completed`, STT local `medium` em 6.344 ms, pipeline total em 21.643 ms, Piper e resposta WAV; readback pós-smoke manteve `ollama.loadedModels=[gemma-hermes:latest]`, sem áudio bruto.
- Boot de produção `npm start` em porta isolada `3001` passou com Postgres, health `ok` e depois a instância auxiliar foi encerrada; Core principal permaneceu em `3000`.
- A dashboard real exibiu as 12 áreas, controles de retenção, histórico com provider/modelo/latências separadas e o fluxo de configuração Groq-only.
- O fluxo de voz foi exercitado no browser; capturas sem fala foram classificadas pela Groq como entrada inválida, enquanto uma sessão com áudio decodificável completou Groq → Gemma → Piper.

### Limitações honestas

- O benchmark comparou somente os dois modelos Groq porque o usuário solicitou retirar Faster-Whisper da dashboard e o runtime local não está instalado; o backend legado permanece apenas para compatibilidade.
- A fixture usada no benchmark é voz sintetizada pelo Piper e não comprova entendimento de fala humana espontânea. Para uma decisão de qualidade, ainda é necessário um conjunto de frases PT-BR humanas autorizadas e redigidas.
- O preview real não encontrou sessões elegíveis com mais de 30 dias; a exclusão real foi validada por testes e o store PostgreSQL por fixture, sem remover histórico do usuário.
- O modelo local continua `medium` por segurança/qualidade; `small`/`base` são opções de menor custo, não uma promoção de precisão.

## 6. Definition of Done

- [x] `GroqSttProvider` testado com fetch injetado e erros classificados.
- [x] `SttRouter` suporta local/Groq/auto e fallback sem retry duplicado.
- [x] Modelo/idioma/timeout/fallback/quota aparecem na dashboard e são validados no backend.
- [x] Segredo Groq nunca retorna em API, UI, logs, sessões, auditoria ou docs.
- [x] Health mostra provider efetivo, local/cloud, modelo e quota sem dados sensíveis.
- [x] Piper `pt_BR-jeff-medium` continua funcionando sem alteração.
- [x] Apenas um worker/modelo local é mantido por vez; GPU continua reservada conforme a regra existente.
- [x] Preview e exclusão de sessões estão implementados em memória e PostgreSQL; a exclusão real só será feita quando houver uma sessão elegível e confirmação explícita.
- [x] Exclusão requer confirmação, revalida sessões ativas e preserva auditoria/recordings/Drive.
- [x] Conteúdo das conversas vinculadas é redigido sem apagar o trilho estrutural de auditoria.
- [x] Auto-retention permanece desligada até opt-in explícito.
- [x] Nenhum áudio bruto fica persistido.
- [x] Benchmark live compara `whisper-large-v3-turbo` e `whisper-large-v3` com a mesma fixture sintética; a comparação local foi retirada do escopo da dashboard por decisão explícita.
- [x] `npm test` e `npm run build` passam com contagens reais registradas no plano.
- [x] Core continua em loopback e dashboard somente via Tailscale Serve, sem Funnel.

## Próxima fase recomendada

Com a fase de STT/dashboard encerrada, o próximo vertical slice deve voltar ao
plano de AI + DVR:

1. calibrar o detector ONNX no enquadramento definitivo, ampliando amostras de
   chuva, contraluz, IR, oclusões, pessoas próximas/distantes, animais,
   veículos, plantas e sombras;
2. exercitar operação contínua em `dry-run` com heartbeat/PID, confirmação
   temporal e métricas de falso positivo antes de qualquer publicação;
3. amadurecer a timeline/DVR e a indexação vinculada a evidências, mantendo
   gravação independente do Gemma;
4. só depois avaliar retenção/arquivamento em lote no Drive e qualquer
   automação física, que continua bloqueada.

O benchmark futuro de qualidade deve usar várias frases PT-BR humanas,
autorizadas e redigidas, sem reintroduzir Faster-Whisper na dashboard. A quota
cloud e a confirmação de saída de áudio continuam obrigatórias.
