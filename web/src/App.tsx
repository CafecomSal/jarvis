import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  JarvisApiClient,
  type ApiTag,
  type AudioSession,
  type ConversationResult,
  type SystemHealthSnapshot,
  type TimelineItem,
  type TimelineResult,
} from './api/client.js';
import { NAV_ITEMS, cameraFramePresentation, cameraLiveState, formatTimestamp, pageFromHash, pageTitle, type PageId } from './app-model.js';
import { PushToTalkLatch } from './audio/push-to-talk.js';
import { audioConstraints, preferredAudioInput } from './audio/audio-input.js';
import { attachLiveVideoPlayer } from './cameras/live-video-player.js';
import { AudioSessionManager, RuntimeSettingsPanel } from './audio/audio-dashboard.js';
import { removeDeletedAudioSessions } from './audio/audio-session-actions.js';

const api = new JarvisApiClient();

type JsonRecord = Record<string, unknown>;

function stringValue(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback = '—'): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function latencyValue(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`.trim()}>{children}</section>;
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'neutral' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: 'ok' | 'warn' | 'danger' | 'neutral' }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value metric-${tone}`}>{value}</div>
      {detail && <div className="metric-detail">{detail}</div>}
    </div>
  );
}

function ErrorMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner"><strong>Indisponível</strong><span>{message}</span></div>;
}

function Loading() {
  return <div className="loading"><span className="spinner" /> carregando dados locais…</div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><div className="empty-icon">◌</div><strong>{title}</strong><span>{detail}</span></div>;
}

function StatusTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (['ok', 'configured', 'healthy', 'verified', 'completed'].includes(status)) return 'ok';
  if (['degraded', 'unknown', 'not_configured', 'recording', 'transcribing'].includes(status)) return 'warn';
  if (['failed', 'error'].includes(status)) return 'danger';
  return 'neutral';
}

function OverviewPage({ health }: { health: SystemHealthSnapshot | null }) {
  if (!health) return <Loading />;
  const statusTone = StatusTone(health.status);
  const audioSummary = health.audio.status !== 'configured'
    ? 'Áudio: provider ainda não ativado'
    : health.audio.source?.startsWith('Groq')
      ? 'Groq STT + Piper TTS disponíveis'
      : 'Áudio STT/TTS disponível';
  return (
    <div className="page-stack">
      <div className="hero-card">
        <div>
          <div className="eyebrow">JARVIS CORE / LOCAL-FIRST</div>
          <h2>Visão operacional</h2>
          <p>Percepção, histórico e conversa em uma única superfície. O modelo propõe; o Core valida.</p>
        </div>
        <Pill tone={statusTone}>{health.status === 'ok' ? 'operacional' : health.status}</Pill>
      </div>
      <div className="metric-grid">
        <Metric label="Core" value={health.core.status} tone={StatusTone(health.core.status)} detail="orquestração e política" />
        <Metric label="Gemma" value={health.model.name} tone={StatusTone(health.model.status)} detail={health.model.runtime} />
        <Metric label="PostgreSQL" value={health.database.status} tone={StatusTone(health.database.status)} detail="eventos, auditoria e DVR" />
        <Metric label="Áudio" value={health.audio.status} tone={StatusTone(health.audio.status)} detail="PC + Alexa via HA" />
      </div>
      <div className="content-grid two-columns">
        <Card>
          <div className="card-heading"><div><div className="eyebrow">CAMADAS ATIVAS</div><h3>O que está funcionando</h3></div><span className="card-symbol">✦</span></div>
          <ul className="signal-list">
            <li><span className="signal-dot signal-ok" /> Conversa e VLM local via Ollama</li>
            <li><span className="signal-dot signal-ok" /> Detecção YOLO/ONNX separada</li>
            <li><span className="signal-dot signal-ok" /> Timeline e catálogo de gravações</li>
            <li><span className="signal-dot signal-ok" /> Tags derivadas de objetos e OCR</li>
            <li><span className={`signal-dot ${health.audio.status === 'configured' ? 'signal-ok' : 'signal-warn'}`} /> {audioSummary}</li>
          </ul>
        </Card>
        <Card>
          <div className="card-heading"><div><div className="eyebrow">GUARDRAILS</div><h3>Limites atuais</h3></div><span className="card-symbol">⌁</span></div>
          <ul className="signal-list">
            <li><span className="signal-dot signal-ok" /> Ações físicas bloqueadas</li>
            <li><span className="signal-dot signal-ok" /> Publicação explícita e auditada</li>
            <li><span className="signal-dot signal-ok" /> Uma residência de modelo por GPU</li>
            <li><span className="signal-dot signal-ok" /> Drive só após readback verificado</li>
            <li><span className="signal-dot signal-warn" /> Face ID planejado, não ativo</li>
          </ul>
        </Card>
      </div>
      <Card>
        <div className="card-heading"><div><div className="eyebrow">ÚLTIMO SNAPSHOT DE SAÚDE</div><h3>Estado seguro e legível</h3></div><span className="muted">{formatTimestamp(health.checkedAt)}</span></div>
        <div className="detail-grid">
          <div><span>Rede</span><strong>{health.network.exposure}</strong></div>
          <div><span>Bind</span><strong>{health.network.bind}</strong></div>
          <div><span>Staging DVR</span><strong>{health.recordings.staging}</strong></div>
          <div><span>Fonte de áudio</span><strong>{health.audio.source ?? 'não configurada'}</strong></div>
        </div>
      </Card>
    </div>
  );
}

function CamerasPage() {
  return <CamerasPageV2 />;
}

function CamerasPageV2() {
  const [previewFailed, setPreviewFailed] = useState(false);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>();
  const [videoError, setVideoError] = useState<string | null>(null);
  const [health, setHealth] = useState<JsonRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    void api.getCameraHealth('front').then(setHealth).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'health indisponível'));
  }, []);
  const rawStatus = stringValue(health?.status, 'consultando');
  const status = error ? 'error' : rawStatus;
  const tone = status === 'ok' ? 'ok' : status === 'consultando' ? 'neutral' : 'danger';
  const liveVideoUrl = api.getCameraLiveVideoUrl('front');
  const liveState = cameraLiveState(status, previewFailed);
  const framePresentation = cameraFramePresentation(sourceSize?.width, sourceSize?.height);
  useEffect(() => {
    if (liveState !== 'ready' || !videoRef.current) return;
    const video = videoRef.current;
    const player = attachLiveVideoPlayer(video, liveVideoUrl, (message) => {
      setVideoError(message ?? 'mpegts player error');
      setPreviewFailed(true);
    });
    if (!player) {
      setPreviewFailed(true);
      return;
    }
    const updateSize = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSourceSize({ width: video.videoWidth, height: video.videoHeight });
      }
    };
    video.addEventListener('loadedmetadata', updateSize);
    video.addEventListener('resize', updateSize);
    updateSize();
    return () => {
      video.removeEventListener('loadedmetadata', updateSize);
      video.removeEventListener('resize', updateSize);
      player.destroy();
    };
  }, [liveState, liveVideoUrl]);
  return (
    <div className="page-stack">
      <div className="section-intro"><div><div className="eyebrow">PERCEPÇÃO</div><h2>Câmeras</h2><p>Vídeo ao vivo de baixa latência; evidência e alta qualidade ficam na timeline.</p></div><Pill tone={tone}>{status}</Pill></div>
      <ErrorMessage message={error} />
      <div className="content-grid camera-layout">
        <Card className="camera-card">
          <div className="camera-header"><div><h3>Frente</h3><span className="muted">mosaico RTSP · dois painéis</span></div><Pill tone={tone}>{status}</Pill></div>
          <div className="camera-viewport" style={framePresentation.aspectRatio ? { aspectRatio: framePresentation.aspectRatio } : undefined}>
            {liveState === 'ready' && <video ref={videoRef} aria-label="Vídeo ao vivo da câmera da frente" style={{ objectFit: framePresentation.objectFit }} autoPlay muted playsInline preload="none" onError={() => { setVideoError('HTMLMediaElement error'); setPreviewFailed(true); }} />}
            {liveState === 'loading' && <div className="camera-fallback"><span className="camera-glyph">◌</span><strong>Conectando ao vídeo ao vivo</strong><span>Validando o health da câmera antes de abrir o stream.</span></div>}
            {liveState === 'unavailable' && <div className="camera-fallback"><span className="camera-glyph">◉</span><strong>{status === 'ok' ? 'Vídeo ao vivo indisponível' : 'Câmera indisponível'}</strong><span>{status === 'ok' ? (videoError ?? 'O Core não recebeu um frame do vídeo H.264.') : `Health da câmera: ${status}.`}</span></div>}
            <span className="camera-stamp">LIVE VIDEO · H.264</span>
          </div>
          <div className="camera-footer"><span><i className={`signal-dot ${status === 'ok' ? 'signal-ok' : 'signal-warn'}`} /> {status}</span><span>{sourceSize ? `${sourceSize.width}×${sourceSize.height}` : 'resolução detectando…'}</span><span>15 FPS origem</span></div>
        </Card>
        <Card>
          <div className="card-heading"><div><div className="eyebrow">CAMERA HEALTH</div><h3>Pipeline</h3></div><span className="card-symbol">◌</span></div>
          <div className="health-rows"><div><span>Snapshot</span><Pill tone={status === 'ok' ? 'ok' : 'danger'}>{status === 'ok' ? 'disponível' : status}</Pill></div><div><span>Detector</span><Pill tone="warn">sob demanda</Pill></div><div><span>OCR</span><Pill tone="warn">sob demanda</Pill></div><div><span>Stream web</span><Pill tone={status === 'ok' ? 'ok' : 'danger'}>{status === 'ok' ? 'ao vivo · H.264/MPEG-TS' : status}</Pill></div></div>
          <div className="callout"><strong>Privacidade</strong><span>RTSP nunca chega ao navegador. A interface recebe apenas vídeo H.264 servido pelo Core.</span></div>
        </Card>
      </div>
    </div>
  );
}

function useTimeline() {
  const [data, setData] = useState<TimelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.getTimeline('?limit=100').then((result) => { if (active) setData(result); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'falha de timeline'); });
    return () => { active = false; };
  }, []);
  return { data, error };
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const recording = item.kind === 'recording' ? item.recording as JsonRecord : undefined;
  return (
    <div className="timeline-row">
      <div className={`timeline-icon ${item.kind === 'recording' ? 'timeline-recording' : 'timeline-event'}`}>{item.kind === 'recording' ? '▶' : '✦'}</div>
      <div className="timeline-main"><strong>{item.type}</strong><span>{formatTimestamp(item.timestamp)}</span></div>
      <div className="timeline-meta">
        <span>{stringValue(item.camera ?? recording?.camera, 'sem câmera')}</span>
        {recording && <span>{numberValue(recording.durationMs)} ms · {numberValue(recording.bytes)} bytes</span>}
        {typeof item.confidence === 'number' && <Pill tone={item.confidence >= 0.7 ? 'ok' : 'warn'}>{Math.round(item.confidence * 100)}%</Pill>}
      </div>
    </div>
  );
}

function TimelinePage() {
  const { data, error } = useTimeline();
  return (
    <div className="page-stack">
      <div className="section-intro"><div><div className="eyebrow">HISTÓRICO</div><h2>Timeline / DVR</h2><p>Gravações, evidências e observações em uma única linha temporal.</p></div><button className="button secondary" onClick={() => window.location.reload()}>Atualizar</button></div>
      <ErrorMessage message={error} />
      <Card className="timeline-card">
        <div className="filter-bar"><span className="filter-label">front</span><span className="filter-label">últimos eventos</span><span className="filter-spacer" /><Pill tone="neutral">read-only</Pill></div>
        {!data && !error && <Loading />}
        {data?.items.length === 0 && <Empty title="Timeline vazia" detail="Ainda não há gravações ou eventos dentro do filtro atual." />}
        {data && data.items.length > 0 && <div className="timeline-list">{data.items.map((item) => <TimelineRow key={`${item.kind}-${item.id}`} item={item} />)}</div>}
      </Card>
    </div>
  );
}

function EventsPage() {
  const [events, setEvents] = useState<JsonRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.getEvents('?limit=50').then((result) => setEvents(result.events)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'falha de eventos')); }, []);
  return (
    <div className="page-stack"><div className="section-intro"><div><div className="eyebrow">EVIDÊNCIA</div><h2>Eventos</h2><p>Detecções confirmadas e propostas de importância do Core.</p></div><Pill tone="neutral">{events.length} carregados</Pill></div><ErrorMessage message={error} /><Card><div className="event-table">{events.length === 0 && !error && <Loading />}{events.map((event, index) => <div className="event-row" key={stringValue(event.id, `event-${index}`)}><div className="event-type">{stringValue(event.type)}</div><div><strong>{stringValue(event.location, 'local desconhecido')}</strong><span>{formatTimestamp(stringValue(event.timestamp, ''))}</span></div><div className="event-confidence">{typeof event.confidence === 'number' ? `${Math.round(event.confidence * 100)}%` : 'sem score'}</div></div>)}</div></Card></div>
  );
}

function TagsPage({ ocrOnly = false }: { ocrOnly?: boolean }) {
  const [tags, setTags] = useState<ApiTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const query = ocrOnly ? '?namespace=ocr&limit=100' : '?limit=100'; void api.getTags(query).then((result) => setTags(result.tags)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'falha de tags')); }, [ocrOnly]);
  return (
    <div className="page-stack"><div className="section-intro"><div><div className="eyebrow">SEMÂNTICA</div><h2>{ocrOnly ? 'OCR' : 'Tags'}</h2><p>{ocrOnly ? 'Texto observado em evidências, com origem e confiança.' : 'Objetos, atributos, relações e revisões sem apagar a detecção original.'}</p></div><Pill tone="neutral">{tags.length} tags</Pill></div><ErrorMessage message={error} /><Card><div className="tag-cloud">{tags.length === 0 && !error && <Loading />}{tags.map((tag) => <div className="tag-card" key={tag.id}><div className="tag-top"><span className="tag-key">{tag.namespace}.{tag.key}</span><Pill tone={StatusTone(tag.status)}>{tag.status}</Pill></div><strong>{String(tag.value)}</strong><div className="tag-bottom"><span>{tag.source}</span><span>{tag.confidence === undefined ? 'sem score' : `${Math.round(tag.confidence * 100)}%`}</span><span>{tag.camera ?? '—'}</span></div></div>)}</div></Card></div>
  );
}

function ChatPage() {
  const [message, setMessage] = useState('');
  const [answers, setAnswers] = useState<Array<{ question: string; result?: ConversationResult; error?: string }>>([]);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = message.trim();
    if (!value || busy) return;
    setMessage(''); setBusy(true);
    try { const result = await api.postConversation(value); setAnswers((current) => [...current, { question: value, result }]); }
    catch (reason: unknown) { setAnswers((current) => [...current, { question: value, error: reason instanceof Error ? reason.message : 'Core indisponível' }]); }
    finally { setBusy(false); }
  }
  return (
    <div className="page-stack chat-page"><div className="section-intro"><div><div className="eyebrow">CONVERSA FUNDAMENTADA</div><h2>Chat / Gemma</h2><p>As chamadas de ferramentas ficam visíveis; o Core continua sendo a autoridade.</p></div><Pill tone="ok">read + propose</Pill></div><Card className="chat-card"><div className="chat-history">{answers.length === 0 && <Empty title="Comece uma conversa" detail="Pergunte sobre estado, eventos, OCR ou gravações. O Gemma consultará as tools adequadas." />}{answers.map((item, index) => <div className="chat-turn" key={`${item.question}-${index}`}><div className="chat-question">{item.question}</div>{item.error ? <div className="chat-error">{item.error}</div> : <div className="chat-answer"><div>{item.result?.answer}</div>{item.result?.toolCalls.length ? <div className="tool-trace">{item.result.toolCalls.map((call) => <span key={call.id}>↳ {call.name}</span>)}</div> : null}</div>}</div>)}</div><form className="chat-form" onSubmit={submit}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Pergunte ao Jarvis…" aria-label="Mensagem para o Jarvis" disabled={busy} /><button className="button primary" disabled={busy || !message.trim()}>{busy ? 'consultando…' : 'Enviar'}</button></form></Card></div>
  );
}

function AudioPageV2() {
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pressLatchRef = useRef(new PushToTalkLatch());
  const [audioInputs, setAudioInputs] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [selectedAudioInput, setSelectedAudioInput] = useState('');

  async function refreshAudioInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microfone ${index + 1}`,
        }));
      setAudioInputs(inputs);
      const preferred = preferredAudioInput(inputs);
      setSelectedAudioInput((current) => current && inputs.some((input) => input.deviceId === current)
        ? current
        : preferred?.deviceId ?? '');
    } catch {
      setAudioInputs([]);
    }
  }

  useEffect(() => {
    let active = true;
    void refreshAudioInputs();
    void api.getAudioSessions('?limit=20').then((result) => { if (active) setSessions(result.sessions); }).catch(() => undefined);
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
    };
  }, []);

  async function startRecording() {
    if (recording || busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMessage('Este navegador não oferece captura MediaRecorder.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints(selectedAudioInput));
      void refreshAudioInputs();
      if (pressLatchRef.current.shouldStop()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const recordingStartedAt = recordingStartedAtRef.current;
        const durationMs = recordingStartedAt === null ? undefined : Math.max(0, performance.now() - recordingStartedAt);
        recordingStartedAtRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        if (blob.size === 0) { setMessage('Nenhum áudio foi capturado.'); return; }
        setBusy(true); setMessage('transcrevendo pelo router…');
        void api.postPcAudio(blob, durationMs).then((result) => {
          setAnswer(result.conversation.answer);
          setMessage(`STT ${latencyValue(result.session.transcript?.latencyMs)} · total ${latencyValue(result.session.pipelineLatencyMs)} · TTS ${latencyValue(result.audio.latencyMs)}`);
          setSessions((current) => [result.session, ...current].slice(0, 20));
          const playback = new Audio(`data:${result.audio.mimeType};base64,${result.audio.audioBase64}`);
          void playback.play().catch(() => setMessage('Resposta pronta; reprodução bloqueada pelo navegador.'));
        }).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'pipeline de áudio indisponível')).finally(() => setBusy(false));
      };
      if (pressLatchRef.current.shouldStop()) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        return;
      }
      recorder.start();
      recordingStartedAtRef.current = performance.now();
      setRecording(true);
      setMessage('ouvindo… solte para enviar');
    } catch {
      setMessage('Permissão de microfone recusada ou indisponível.');
    }
  }

  function pressToTalk() {
    if (busy) return;
    pressLatchRef.current.press();
    void startRecording();
  }

  function releaseToTalk() {
    pressLatchRef.current.release();
    stopRecording();
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  }

  return (
    <div className="page-stack"><div className="section-intro"><div><div className="eyebrow">VOICE ROUTER</div><h2>Áudio</h2><p>Segure o botão para falar. O PC usa Groq Whisper; Alexa permanece como canal HA híbrido.</p></div><Pill tone={busy ? 'warn' : recording ? 'ok' : 'neutral'}>{busy ? 'processando' : recording ? 'ouvindo' : 'push-to-talk'}</Pill></div><div className="content-grid two-columns"><Card className="voice-card"><div className="voice-orb"><span>{recording ? '●' : '◖'}</span></div><h3>{recording ? 'Solte para enviar' : 'Segure para falar'}</h3><p>O áudio bruto é enviado somente durante a sessão e não é persistido no histórico.</p>{audioInputs.length > 0 && <label className="audio-input-picker"><span>Entrada</span><select aria-label="Selecionar microfone" value={selectedAudioInput} disabled={busy || recording} onChange={(event) => setSelectedAudioInput(event.target.value)}>{audioInputs.map((input) => <option key={input.deviceId} value={input.deviceId}>{input.label}</option>)}</select></label>}<button className="button primary wide" disabled={busy} onPointerDown={pressToTalk} onPointerUp={releaseToTalk} onPointerLeave={releaseToTalk} onPointerCancel={releaseToTalk} onKeyDown={(event) => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) pressToTalk(); }} onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') releaseToTalk(); }}>{recording ? '● Gravando' : '◖ Push-to-talk'}</button>{message && <div className="callout"><strong>Estado</strong><span>{message}</span></div>}{answer && <div className="voice-result"><div className="eyebrow">RESPOSTA</div><p>{answer}</p></div>}</Card><Card><div className="card-heading"><div><div className="eyebrow">DESTINOS</div><h3>Roteamento</h3></div><span className="card-symbol">◖</span></div><div className="health-rows"><div><span>PC microphone</span><Pill tone={recording ? 'ok' : 'neutral'}>{recording ? 'capturando' : 'pronto'}</Pill></div><div><span>PC speaker</span><Pill tone={answer ? 'ok' : 'warn'}>{answer ? 'resposta pronta' : 'Piper protegido'}</Pill></div><div><span>Alexa / HA</span><Pill tone="warn">descoberta pendente</Pill></div><div><span>STT cloud</span><Pill tone="neutral">opt-in</Pill></div></div></Card></div><AudioSessionManager api={api} sessions={sessions} onDeleted={(ids) => setSessions((current) => removeDeletedAudioSessions(current, ids))} /><Card><div className="card-heading"><div><div className="eyebrow">HISTÓRICO</div><h3>Sessões recentes</h3></div><span className="muted">{sessions.length} sessões</span></div>{sessions.length ? <div className="timeline-list">{sessions.map((session) => <div className="timeline-row" key={session.id}><div className="timeline-icon timeline-event">◖</div><div className="timeline-main"><strong>{session.source} · {session.status} · {session.transcript?.processingLocation ?? 'local'} · {session.transcript?.provider ?? '—'} / {session.transcript?.model ?? '—'}</strong><span>{formatTimestamp(session.startedAt)} · STT {latencyValue(session.transcript?.latencyMs)} · total {latencyValue(session.pipelineLatencyMs)}</span></div><div className="timeline-meta"><span>{session.transcript?.text ?? 'sem transcript'}</span></div></div>)}</div> : <Empty title="Nenhuma sessão de áudio" detail="Habilite o pipeline de áudio para criar o primeiro registro." />}</Card></div>
  );
}

function ActionsPage() {
  const [proposals, setProposals] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api.getActionProposals().then((result) => setProposals(result.proposals)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'não foi possível carregar propostas');
    });
  }, []);
  return (
    <div className="page-stack">
      <div className="section-intro"><div><div className="eyebrow">AÇÕES / PROPOSTAS</div><h2>Nada executa sem confirmação</h2><p>O Gemma pode sugerir; a política determinística e a confirmação humana decidem.</p></div><Pill tone="warn">read-only</Pill></div>
      <div className="callout"><strong>Estado atual</strong><span>Endpoints de escrita, confirmação e execução física permanecem bloqueados.</span></div>
      <ErrorMessage message={error ?? null} />
      <section className="list">
        {proposals.length === 0 && <Empty title="Nenhuma proposta pendente" detail="Watch sessions e o Gemma ainda não publicaram propostas nesta execução." />}
        {proposals.map((proposal, index) => {
          const status = stringValue(proposal.status, 'proposed');
          return <Card key={stringValue(proposal.id, `proposal-${index}`)}><div className="list-head"><div><strong>{stringValue(proposal.summary, 'Proposta sem resumo')}</strong><span>{stringValue(proposal.toolName, 'tool desconhecida')}</span></div><Pill tone={StatusTone(status)}>{status}</Pill></div><div className="tag-row"><Pill tone="neutral">risco {stringValue(proposal.risk, 'unknown')}</Pill><span className="muted">evidências: {Array.isArray(proposal.evidenceIds) ? proposal.evidenceIds.length : 0}</span></div></Card>;
        })}
      </section>
    </div>
  );
}

function DrivePage() {
  const [recordings, setRecordings] = useState<JsonRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.getRecordings('?limit=50').then((result) => setRecordings(result.recordings)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'catálogo indisponível')); }, []);
  return <div className="page-stack"><div className="section-intro"><div><div className="eyebrow">ARQUIVO</div><h2>Drive</h2><p>Upload verificado, fila e retenção; nenhum segmento é removido antes do readback.</p></div><Pill tone="warn">scheduler opt-in</Pill></div><ErrorMessage message={error} /><div className="metric-grid"><Metric label="Segmentos" value={String(recordings.length)} detail="catálogo consultado" /><Metric label="Contínuo" value="30 dias" detail="policy planejada" tone="ok" /><Metric label="Eventos" value="90 dias" detail="tags relevantes" tone="ok" /><Metric label="Local" value="staging" detail="temporário" tone="warn" /></div><Card><div className="card-heading"><div><div className="eyebrow">CATÁLOGO</div><h3>Últimos segmentos</h3></div></div>{recordings.length ? <div className="event-table">{recordings.map((recording, index) => <div className="event-row" key={stringValue(recording.id, `recording-${index}`)}><div className="event-type">{stringValue(recording.camera)}</div><div><strong>{formatTimestamp(stringValue(recording.startedAt, ''))}</strong><span>{numberValue(recording.durationMs)} ms · {stringValue(recording.backupStatus)}</span></div><div className="event-confidence">{stringValue(recording.driveWebViewLink, 'local')}</div></div>)}</div> : <Empty title="Catálogo indisponível ou vazio" detail="Configure o banco e o gravador para visualizar os segmentos." />}</Card></div>;
}

function SystemPage({ health }: { health: SystemHealthSnapshot | null }) {
  return <div className="page-stack"><div className="section-intro"><div><div className="eyebrow">OBSERVABILIDADE</div><h2>Sistema</h2><p>Health, modelos, GPU e processos sem comandos mutáveis.</p></div><Pill tone={health ? StatusTone(health.status) : 'warn'}>{health?.status ?? 'consultando'}</Pill></div><Card><pre className="json-view">{health ? JSON.stringify(health, null, 2) : 'carregando…'}</pre></Card></div>;
}

function SettingsPage() {
  return <RuntimeSettingsPanel api={api} />;
}

export function App() {
  const [page, setPage] = useState<PageId>(() => pageFromHash(window.location.hash));
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const currentNav = useMemo(() => NAV_ITEMS.find((item) => item.id === page) ?? NAV_ITEMS[0], [page]);

  useEffect(() => {
    const syncPageFromUrl = () => setPage(pageFromHash(window.location.hash));
    window.addEventListener('hashchange', syncPageFromUrl);
    return () => window.removeEventListener('hashchange', syncPageFromUrl);
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => { void api.getHealth().then((result) => { if (active) { setHealth(result); setHealthError(null); } }).catch((reason: unknown) => { if (active) setHealthError(reason instanceof Error ? reason.message : 'Core indisponível'); }); };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  function renderPage(): ReactNode {
    switch (page) {
      case 'overview': return <OverviewPage health={health} />;
      case 'cameras': return <CamerasPageV2 />;
      case 'timeline': return <TimelinePage />;
      case 'events': return <EventsPage />;
      case 'tags': return <TagsPage />;
      case 'ocr': return <TagsPage ocrOnly />;
      case 'chat': return <ChatPage />;
      case 'audio': return <AudioPageV2 />;
      case 'drive': return <DrivePage />;
      case 'system': return <SystemPage health={health} />;
      case 'actions': return <ActionsPage />;
      case 'settings': return <SettingsPage />;
      default: return <OverviewPage health={health} />;
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">J</div><div><strong>JARVIS</strong><span>CORE / LOCAL</span></div></div>
        <div className="sidebar-status"><span className={`status-led ${health ? 'led-ok' : 'led-warn'}`} /> <span>{health ? 'Core monitorado' : 'Conectando ao Core'}</span></div>
        <nav className="nav-list" aria-label="Navegação principal">{NAV_ITEMS.map((item) => <a key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} href={`#${item.id}`} title={item.description}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'audio' && <span className="nav-badge">β</span>}</a>)}</nav>
        <div className="sidebar-footer"><div className="mini-label">ACCESS</div><strong>Tailscale only</strong><span>loopback Core · sem exposição pública</span></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><div className="breadcrumb">JARVIS <span>/</span> {currentNav.label}</div><h1>{pageTitle(page)}</h1></div><div className="topbar-actions"><div className="model-chip"><span className="model-dot" /> gemma-hermes:latest</div><div className="resource-chip">GPU <strong>1 modelo máx.</strong></div></div></header>
        {healthError && <ErrorMessage message={healthError} />}
        {renderPage()}
        <footer className="footer"><span>Jarvis Core · local-first</span><span>modelo propõe · Core valida</span></footer>
      </main>
    </div>
  );
}
