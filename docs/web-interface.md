# Interface web do Jarvis Core

O dashboard é React/Vite e é servido pelo Core em `/ui/`. A API permanece na mesma origem, evitando CORS e mantendo RTSP fora do navegador.

## Construir e abrir

```bash
npm run build
npm run dev
# http://127.0.0.1:3000/ui/
```

Módulos: overview, câmeras, timeline/DVR, eventos, tags, OCR, chat/Gemma, áudio, Drive, sistema, ações e configurações.

A tela é read-only nesta fase. Propostas de ação são somente exibidas; não há confirmação/execução HTTP.

## Preview ao vivo

`GET /cameras/:camera/preview` retorna um JPEG pontual. Para a experiência ao vivo, a dashboard usa `GET /cameras/:camera/live-video`, um stream contínuo `video/mp2t` com vídeo H.264 transcodificado pelo Core a partir do RTSP HEVC. O player `mpegts.js` usa MSE sem stash buffer e ajusta a reprodução para perseguir a borda ao vivo. A largura de saída padrão é 1280 (`JARVIS_LIVE_VIDEO_WIDTH`), preservando a proporção do mosaico; o processo FFmpeg é por conexão e termina quando o cliente fecha. `GET /cameras/:camera/live` permanece como MJPEG legado, e `GET /cameras/:camera/health` continua sendo a fonte de verdade do status. Nenhum preview cria evidência nem registra evento.

## Áudio

A aba **Áudio** usa MediaRecorder e `POST /audio/pc`. O payload é bounded e o áudio bruto não é gravado no histórico. O response contém transcript, resposta textual e WAV para reprodução local. O cliente reserva timeout de 180 s para o pipeline completo; as demais APIs usam 30 s.

O STT passa pelo router configurável:

- `local`: Faster-Whisper CPU;
- `groq`: Groq Whisper somente com cloud habilitado, chave backend e confirmação explícita;
- `auto`: tenta Groq sob quota e usa fallback local apenas quando configurado.

A localização do processamento e o provider efetivo aparecem no health, em Configurações e no histórico da sessão. O TTS é Piper `pt_BR-jeff-medium` e permanece protegido.

### Configurações e retenção

A aba **Configurações** permite alterar somente campos allowlisted: rota/modelo/idioma/timeout/fallback do STT, quota local e retenção de sessões. A chave `GROQ_API_KEY` não é editável nem retornada.

Na aba **Áudio**, a limpeza segue `preview → confirmação com quantidade exata → exclusão bounded`. Apenas sessões `completed`/`failed` anteriores à data selecionada entram; sessões ativas, gravações, snapshots, Drive e linhas estruturais de auditoria ficam fora. Conteúdo auditado da conversa vinculada é redigido e o tombstone é preservado. A limpeza automática permanece desligada até opt-in explícito.