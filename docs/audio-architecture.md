# Arquitetura de áudio

```text
PC push-to-talk / hotkey
  -> SttRouter
       -> Faster-Whisper (CPU, int8, worker residente, modelo local configurável)
       -> Groq Whisper (cloud opt-in, uma organização/chave backend, quota local)
  -> ConversationOrchestrator + Gemma
  -> Piper (CPU, pt_BR-jeff-medium)
  -> PC speaker

Alexa/Home Assistant
  -> comandos/intenções do HA
  -> notify.echo_dot_speak ou notify.echo_dot_announce
```

## Estado e gates

- `JARVIS_AUDIO_ENABLED=true` habilita o pipeline no processo do Core.
- A rota default é `local`; `groq` e `auto` só enviam áudio quando `JARVIS_CLOUD_STT_ENABLED=true`, a configuração efetiva autoriza cloud e `GROQ_API_KEY` existe no backend.
- `whisper-large-v3-turbo` é o candidato Groq de baixa latência; `whisper-large-v3` é a alternativa de precisão. A lista é allowlisted.
- O timeout, fallback, idioma, prompt contextual e modelos podem vir do runtime settings. Segredos, URL de banco, RTSP, Tailscale, GPU e ações físicas não são editáveis pela dashboard.
- A quota local controla requests/dia, segundos/dia e custo estimado; os limites reais da organização Groq são observados separadamente pelos headers da API. Não há rotação de chaves/contas.
- `JARVIS_CLOUD_TTS_ENABLED=false` e `JARVIS_CLOUD_STT_ENABLED=false` continuam sendo defaults de segurança.
- Azure TTS é opcional e exige chave/região explícitas, cache e quota mensal; não é alterado nesta fase.
- Nenhum provider de áudio usa a GPU; o Gemma continua sendo o único modelo GPU possível.

## Provider e fallback

`GroqSttProvider` usa o endpoint oficial de transcrição compatível com multipart. O Core envia o blob bounded recebido do browser, força temperatura zero, idioma português e `verbose_json` quando a rota cloud está ativa. O resultado registra provider, modelo, localização (`local`/`cloud`), latência e duração quando disponíveis; confiança não é inventada quando o provider não fornece metadata.

`SttRouter` aceita `local`, `groq` ou `auto`. Fallback local é permitido somente quando configurado e para timeout, indisponibilidade, quota ou erro upstream. Credencial inválida, formato inválido e resposta inválida falham de forma explícita. Não há retry cego de uma requisição ambígua.

## Credenciais e privacidade

`GROQ_API_KEY` é lida exclusivamente no processo do backend. A dashboard mostra apenas `configurada`/`não configurada`. A chave não é persistida nos runtime settings, API responses, sessões, auditoria, logs ou documentação. O áudio bruto permanece somente no request bounded e não é gravado no histórico.

## Dashboard web

A aba Áudio enumera as entradas `audioinput` do navegador e permite escolher o microfone durante a sessão; o `deviceId` não é persistido. Quando disponível, um microfone físico identificado (como Fifine) é selecionado antes de entradas virtuais, sem impedir a troca manual. A captura solicita mono, `16 kHz` ideal, `16-bit`, cancelamento de eco, supressão de ruído e ganho automático. O botão push-to-talk usa pointer/teclado e um latch de soltura: se o usuário soltar antes de `getUserMedia()` terminar, a faixa é encerrada assim que a permissão retornar.

A aba Configurações lê e salva somente o schema allowlisted de runtime. O status distingue provider efetivo e localização cloud. Ativar cloud exige confirmação explícita e uma chave já configurada no backend. Piper `pt_BR-jeff-medium` aparece como protegido.

## Sessões e retenção

Sessões persistem transcript e metadata, nunca `rawAudio`. A limpeza manual usa:

```text
preview com data/status
  -> confirmação com quantidade exata
  -> remoção bounded de audio_sessions
  -> redaction do conteúdo da conversa vinculada por conversationId
  -> tombstone auditado
  -> readback
```

Somente sessões `completed` e `failed` entram na limpeza bulk; estados ativos são protegidos. A linha estrutural do audit log não é removida: conteúdo de mensagem, resposta e tools é redigido, preservando timestamp, actor, outcome e o fato da operação. Gravações, snapshots, Drive e históricos não relacionados não sofrem cascade. Auto-delete é desligado por padrão e só roda quando habilitado explicitamente.

## Hotkey Windows

```bash
npm run audio:hotkey
```

O helper `scripts/pc_voice_hotkey.py` é manual, usa `Ctrl+Alt+J` por padrão, não registra Startup e não mantém o microfone aberto ao iniciar.

## Home Assistant

Destinos observados: `notify.echo_dot_speak` e `notify.echo_dot_announce`. O adapter requer base URL/token configurados externamente; nenhuma skill AWS própria é criada.
