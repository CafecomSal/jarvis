# Operação durável no Windows

O supervisor em `ops/windows/jarvis-supervisor.ps1` inicia e acompanha somente os componentes necessários para o Core local: PostgreSQL via Docker Compose, Ollama e o Core compilado. Ele não inicia detector, hotkey, gravação contínua, upload/delete do Drive nem ações físicas.

## Pré-requisitos

- Docker Desktop deve estar disponível no login do usuário; o supervisor não instala nem altera o Docker Desktop.
- O projeto deve ter `.env`, `DATABASE_URL` não vazia e `dist/src/server.js` gerado por `npm run build`.
- `ollama` e `tailscale` devem estar no PATH. O modelo configurado precisa já existir no Ollama; o supervisor não faz pull automático.
- O Core continua vinculado a `127.0.0.1`. O estado do Tailscale Serve é apenas verificado; `funnel` nunca é configurado.

Os valores de `.env` nunca são exibidos. A chave Groq é opcional e continua sem uso até autorização e benchmark explícitos.

## Comandos

Executar a partir de `C:\Users\davi\jarvis`:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Validate
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Status
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Start
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode Stop
```

`Validate` é somente leitura. `Start` aguarda PostgreSQL por até 120 segundos, Ollama por até 120 segundos e o health do Core por até 60 segundos. O Core é executado a partir de `dist` com o mesmo comando efetivo do `npm start`, mantendo o processo Node diretamente rastreável.

## Task Scheduler

`InstallTask` registra a tarefa `Jarvis Core` no contexto do usuário atual, com:

- trigger no login do usuário e atraso de 30 segundos;
- execução oculta, com menor privilégio e somente enquanto o usuário estiver logado;
- política de instância única (`IgnoreNew`);
- reinício limitado após falha;
- diretório de trabalho e caminhos absolutos do projeto.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode InstallTask
```

Após registrar, o supervisor lê a tarefa de volta e só informa sucesso se ação, usuário, trigger e política de instância corresponderem. Se a leitura for negada ou houver uma tarefa diferente com o mesmo nome, nenhuma tarefa existente é sobrescrita.

Para remover, o Core deve estar parado e a tarefa precisa pertencer ao Jarvis:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\ops\windows\jarvis-supervisor.ps1 -Mode RemoveTask
```

## Estado, logs e falhas

O estado operacional fica em `data\ops\supervisor-state.json`; logs ficam em `data\ops\logs`. Esses arquivos não contêm `.env`, URLs RTSP, tokens, áudio ou chave Groq e são ignorados pelo Git quando houver um repositório.

O supervisor não encerra processos que não iniciou. O state guarda o horário de início dos PIDs próprios e a parada revalida essa identidade antes de terminar um processo, evitando atingir um PID reutilizado. Em conflito de porta ou Core não reconhecido, ele falha de forma segura. Reinícios do Core usam backoff de 5, 15 e 30 segundos; depois do limite, o supervisor para e deixa o diagnóstico nos logs.

O comando `Stop` publica um marcador, aguarda até 30 segundos a instância acompanhada liberar o mutex e só usa limpeza de fallback quando não há supervisor concorrente. Ele encerra somente PIDs próprios, aguarda o shutdown do Core e para o container PostgreSQL apenas quando ele foi iniciado pelo supervisor. Volumes e dados não são removidos.

## Defaults preservados

```text
STT local / medium
cloudEnabled=false
fallback=none
auto-delete=false
detector=manual / dry-run
Tailscale=tailnet-only
ações físicas=bloqueadas
```
