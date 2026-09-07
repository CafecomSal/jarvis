# Auditoria de fluxos interativos do dashboard

Data da auditoria: 2026-09-07

Este documento mantém o inventário dos fluxos que dependem de interação do
usuário, a validação ponta a ponta e o resultado do benchmark de STT.

## Inventário

O dashboard expõe 12 áreas na navegação principal:

`overview`, `cameras`, `timeline`, `events`, `tags`, `ocr`, `chat`, `audio`,
`drive`, `system`, `actions` e `settings`.

| Área/fluxo | Interação | Efeito esperado | Evidência atual | Estado |
| --- | --- | --- | --- | --- |
| Navegação | Clicar nos 12 links laterais | Atualiza o hash e renderiza a página correspondente | `NAV_ITEMS`, `pageFromHash`, teste `web-navigation` e reabertura visual dos 12 destinos nesta build | Operacional |
| Visão geral | Nenhuma | Mostra health agregado e atualiza a cada 15 s | `GET /system/health` atual 200; build atual | Operacional por contrato/API |
| Câmeras | Abrir a área | Consulta health e, se `ok`, abre vídeo H.264 via MPEG-TS; mostra fallback em erro | `GET /cameras/front/health` 200; vídeo atual com `readyState=4`, reproduzindo, 1280x1440 e sem erro de mídia | Operacional |
| Timeline/DVR | Clicar **Atualizar** | Recarrega a página e busca timeline | `GET /timeline?limit=1` atual 200; teste de cliente e inspeção anterior | Operacional por contrato/API |
| Eventos | Abrir a área | Lista eventos read-only | `GET /events?limit=1` atual 200 | Operacional por contrato/API |
| Tags | Abrir a área | Lista tags read-only | `GET /tags?limit=1` atual 200 | Operacional por contrato/API |
| OCR | Abrir a área | Lista somente tags do namespace OCR | Cliente e código usam `?namespace=ocr&limit=100`; endpoint de tags atual 200 | Operacional por contrato/API |
| Chat | Digitar e enviar pergunta; botão fica desabilitado vazio/ocupado | Faz `POST /conversation` e exibe resposta, tools ou erro | Smoke real atual: HTTP 200; no dashboard, `Responda apenas OK.` retornou `OK`. Ollama foi reciclado após falha de recarga multimodal e respondeu 200; ficou com `OLLAMA_NO_CLOUD=1` e retenção de 24 h nesta sessão | Operacional |
| Áudio: escolher microfone | Selecionar `audioinput` | Usa o `deviceId` somente na sessão e prefere Fifine quando disponível | `audio-input` e teste de seleção; UI atual mostrou as entradas do sistema e seleção sem persistência | Operacional |
| Áudio: push-to-talk | Pressionar/soltar botão ou Espaço/Enter | Solicita microfone, grava enquanto pressionado, envia blob bounded e reproduz resposta | Latch, cliente e API têm testes; a captura foi exercitada no navegador; há sessão cloud concluída no histórico e o mesmo pipeline respondeu com Groq + Gemma + Piper usando o fixture sintético | Operacional com áudio decodificável; gestos de auditoria sem fala foram rejeitados como entrada inválida (HTTP 400 da Groq, exposto pela UI como 502) |
| Retenção de áudio: preview | Alterar data/status e clicar **Pré-visualizar exclusão** | Mostra quantidade/status elegíveis sem apagar | Smoke real atual: preview HTTP 200, filtro de 1970 retornou 0; testes de API/UI | Operacional |
| Retenção de áudio: exclusão | Digitar a frase exata e confirmar | Remove somente o preview correspondente, com readback | Gate de confirmação e contrato cobertos; inspeção anterior deixou botão desabilitado com texto errado | Não executado por segurança; não é necessário apagar dados para validar o gate |
| Configurações | Alterar campos allowlisted e salvar | Mantém Groq + modelo allowlisted, quota/retenção e exige confirmação da fronteira cloud | Smoke sem confirmação retornou 400 `cloud_confirmation_required`; readback permaneceu inalterado; UI atual mostra somente `whisper-large-v3-turbo` e `whisper-large-v3` | Operacional |
| Sistema | Abrir a área | Exibe JSON de health read-only | `GET /system/health` atual 200; código sem controles de escrita | Operacional por contrato/API |
| Ações | Abrir a área | Lista propostas; nenhuma execução é oferecida | `GET /actions/proposals` atual 200; teste de API; código sem botões de execução | Operacional por contrato/API |
| Drive | Abrir a área | Lista catálogo local/readback; nenhum upload ou toggle é oferecido | `GET /recordings?limit=1` atual 200; inspeção anterior sem controles de upload | Operacional por contrato/API |

## Validações executadas

- `npm.cmd test -- --run --maxWorkers=1 --minWorkers=1`: 110 arquivos passaram;
  3 foram pulados por dependerem de PostgreSQL; 282 testes passaram e 3 foram
  pulados.
- `npm.cmd run build`: TypeScript e Vite passaram. O Vite emitiu somente o
  aviso de bundle maior que 500 kB.
- Smoke HTTP local: `/`, `/health`, `/system/health`, `/settings`,
  `/events`, `/audit`, `/timeline`, `/tags`, `/audio/sessions`,
  `/watch-sessions`, `/importance`, `/actions/proposals`, `/recordings` e
  `/cameras/front/health` retornaram 200.
- O runtime atual está configurado como Groq STT + Piper CPU, com rota Groq,
  `whisper-large-v3-turbo`, sem fallback e processamento cloud habilitado.
  Nenhuma chave é registrada neste documento.
- O bundle atual contém as duas opções Groq e não contém `Faster-Whisper`.
- Sessões históricas podem conter `faster-whisper` como metadado de execuções
  antigas; isso não aparece como escolha nem é reescrito pela UI.
- `npm.cmd run benchmark:stt` foi executado com
  `data/audio/tts/piper-smoke.wav` (188460 bytes):
  `whisper-large-v3-turbo` respondeu em 534 ms, confiança 0,6405;
  `whisper-large-v3` respondeu em 480 ms, confiança 0,6094. O fixture é
  sintético e nenhum transcript foi registrado neste documento.
- A suíte completa passou em worker único para evitar o OOM do modo paralelo:
  110 arquivos passaram, 3 foram pulados por PostgreSQL; 282 testes passaram,
  3 foram pulados.

## Resultado do benchmark

O gate foi satisfeito: os fluxos interativos foram mapeados, os contratos e
smokes locais passaram, e o pipeline de voz foi validado com captura/browser e
com um áudio sintético decodificável antes da medição dos dois modelos Groq.
Não foram apagadas sessões, enviados arquivos ao Drive ou habilitado fallback
local. A quota atual do Core permanece limitada ao uso autorizado desta
auditoria.
