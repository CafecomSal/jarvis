import { useEffect, useState } from 'react';
import type {
  AudioSession,
  AudioSessionDeletePreview,
  JarvisApiClient,
  RuntimeSettingsResponse,
} from '../api/client.js';
import { audioSessionDeleteConfirmation, removeDeletedAudioSessions } from './audio-session-actions.js';

interface RuntimeSettingsPanelProps {
  api: JarvisApiClient;
}

function settingsDraft(data: RuntimeSettingsResponse) {
  return {
    audioEnabled: data.settings.audioEnabled,
    // The dashboard intentionally exposes Groq as the only STT provider.
    // Older persisted settings may still contain the former local route; the
    // next save migrates them without exposing a broken provider choice.
    route: 'groq' as const,
    groqModel: data.settings.stt.groqModel,
    language: data.settings.stt.language,
    prompt: data.settings.stt.prompt,
    fallback: 'none' as const,
    timeoutMs: data.settings.stt.timeoutMs,
    // Preserve an explicit Groq opt-out after the user saves it. Legacy local
    // settings are migrated with the cloud gate ready for the requested route.
    cloudEnabled: data.settings.stt.route === 'groq' ? data.settings.stt.cloudEnabled : true,
    maxRequestsPerDay: data.settings.quota.maxRequestsPerDay,
    maxAudioSecondsPerDay: data.settings.quota.maxAudioSecondsPerDay,
    maxEstimatedMonthlyUsd: data.settings.quota.maxEstimatedMonthlyUsd,
    autoDeleteEnabled: data.settings.audioSessions.autoDeleteEnabled,
    retentionDays: data.settings.audioSessions.retentionDays,
  };
}

type SettingsDraft = ReturnType<typeof settingsDraft>;

export function RuntimeSettingsPanel({ api }: RuntimeSettingsPanelProps) {
  const [data, setData] = useState<RuntimeSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [cloudConfirmation, setCloudConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void api.getSettings().then((result) => {
      if (!active) return;
      setData(result);
      setDraft(settingsDraft(result));
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : 'settings indisponíveis');
    });
    return () => { active = false; };
  }, [api]);

  function setField<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!draft || busy) return;
    const requestsCloud = true;
    if (requestsCloud && !cloudConfirmation) {
      setMessage('Confirme explicitamente que o áudio poderá sair da máquina.');
      return;
    }
    setBusy(true);
    setMessage('aplicando settings…');
    try {
      const result = await api.updateSettings({
        audioEnabled: draft.audioEnabled,
        stt: {
          route: draft.route,
          groqModel: draft.groqModel,
          language: draft.language,
          prompt: draft.prompt,
          fallback: draft.fallback,
          timeoutMs: draft.timeoutMs,
          cloudEnabled: draft.cloudEnabled,
        },
        quota: {
          maxRequestsPerDay: draft.maxRequestsPerDay,
          maxAudioSecondsPerDay: draft.maxAudioSecondsPerDay,
          maxEstimatedMonthlyUsd: draft.maxEstimatedMonthlyUsd,
        },
        audioSessions: {
          autoDeleteEnabled: draft.autoDeleteEnabled,
          retentionDays: draft.retentionDays,
          deletableStatuses: ['completed', 'failed'],
        },
      }, requestsCloud && cloudConfirmation);
      setData(result);
      setDraft(settingsDraft(result));
      setCloudConfirmation(false);
      setMessage(result.restartRequired ? 'salvo; reinício necessário para aplicar tudo' : 'settings aplicados');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'falha ao aplicar settings');
    } finally {
      setBusy(false);
    }
  }

  if (!data || !draft) return <div className="page-stack"><div className="loading"><span className="spinner" /> carregando settings…</div></div>;
  const requestsCloud = true;
  const usage = data.settings.quota.usage;
  const activeProvider = data.settings.stt.activeProvider ?? 'groq (pendente de aplicação)';
  const location = data.settings.stt.processingLocation ?? 'cloud';

  return (
    <div className="page-stack">
      <div className="section-intro"><div><div className="eyebrow">POLICY / RUNTIME</div><h2>Configurações</h2><p>Settings operacionais allowlisted; segredos e ações críticas continuam fora da UI.</p></div><span className="pill pill-neutral">{data.source}</span></div>
      <div className="content-grid two-columns">
        <section className="card">
          <div className="card-heading"><div><div className="eyebrow">STT ROUTER</div><h3>Provider e fallback</h3></div><span className={`pill pill-${location === 'cloud' ? 'warn' : 'ok'}`}>{location}</span></div>
          <div className="settings-form">
            <label><span>Pipeline de áudio</span><input type="checkbox" checked={draft.audioEnabled} onChange={(event) => setField('audioEnabled', event.target.checked)} /><small>habilitar após reinício se necessário</small></label>
            <label><span>Provider STT</span><input value="Groq Whisper" readOnly /><small>provider cloud único desta configuração</small></label>
            <label><span>Modelo Groq</span><select value={draft.groqModel} onChange={(event) => setField('groqModel', event.target.value)}><option value="whisper-large-v3-turbo">whisper-large-v3-turbo</option><option value="whisper-large-v3">whisper-large-v3</option></select></label>
            <label><span>Idioma</span><input value={draft.language} onChange={(event) => setField('language', event.target.value)} /></label>
            <label><span>Fallback</span><input value="Sem fallback" readOnly /><small>nenhum áudio é redirecionado para outro provider</small></label>
            <label><span>Timeout (ms)</span><input type="number" min="100" max="120000" step="100" value={draft.timeoutMs} onChange={(event) => setField('timeoutMs', Number(event.target.value))} /></label>
            <label><span>Prompt contextual (opcional)</span><input value={draft.prompt} maxLength={1000} onChange={(event) => setField('prompt', event.target.value)} /></label>
          </div>
          <div className="callout"><strong>Estado efetivo</strong><span>{activeProvider} · {location} · cloud {data.cloud.groq.configured ? 'configurado' : 'sem chave'}</span></div>
        </section>
        <section className="card">
          <div className="card-heading"><div><div className="eyebrow">CLOUD GATE</div><h3>Groq</h3></div><span className={`pill pill-${data.cloud.groq.configured ? 'ok' : 'neutral'}`}>{data.cloud.groq.configured ? 'chave configurada' : 'sem chave'}</span></div>
          <p className="muted">A chave fica somente no ambiente do backend. Esta tela nunca solicita nem exibe o segredo.</p>
          <label className="setting-check"><input type="checkbox" checked={draft.cloudEnabled} onChange={(event) => setField('cloudEnabled', event.target.checked)} /><span>Permitir envio de áudio para Groq</span></label>
          {requestsCloud && <label className="setting-check"><input type="checkbox" checked={cloudConfirmation} onChange={(event) => setCloudConfirmation(event.target.checked)} /><span>Confirmo que o áudio poderá sair desta máquina</span></label>}
          <div className="health-rows"><div><span>Provider atual</span><strong>{activeProvider}</strong></div><div><span>Localização</span><strong>{location}</strong></div><div><span>Uso hoje / mês</span><strong>{usage ? `${usage.requests ?? 0} req · ${usage.audioSeconds ?? 0}s · $${Number(usage.monthlyEstimatedUsd ?? usage.estimatedUsd ?? 0).toFixed(4)} / $${draft.maxEstimatedMonthlyUsd.toFixed(2)}` : 'sem chamadas cloud'}</strong></div></div>
          <div className="callout"><strong>Quota</strong><span>Os limites da conta são por organização e podem variar. O Jarvis aplica um teto local independente.</span></div>
        </section>
      </div>
      <div className="content-grid two-columns">
        <section className="card"><div className="card-heading"><div><div className="eyebrow">LIMITES LOCAIS</div><h3>Quota cloud</h3></div></div><div className="settings-form"><label><span>Máx. requests/dia</span><input type="number" min="1" value={draft.maxRequestsPerDay} onChange={(event) => setField('maxRequestsPerDay', Number(event.target.value))} /></label><label><span>Máx. segundos/dia</span><input type="number" min="1" value={draft.maxAudioSecondsPerDay} onChange={(event) => setField('maxAudioSecondsPerDay', Number(event.target.value))} /></label><label><span>Máx. custo estimado/mês (USD)</span><input type="number" min="0" step="0.01" value={draft.maxEstimatedMonthlyUsd} onChange={(event) => setField('maxEstimatedMonthlyUsd', Number(event.target.value))} /></label></div></section>
        <section className="card"><div className="card-heading"><div><div className="eyebrow">RETENÇÃO</div><h3>Sessões de áudio</h3></div></div><div className="settings-form"><label className="setting-check"><input type="checkbox" checked={draft.autoDeleteEnabled} onChange={(event) => setField('autoDeleteEnabled', event.target.checked)} /><span>Limpeza automática (opt-in)</span></label><label><span>Reter por dias</span><input type="number" min="1" max="3650" value={draft.retentionDays} onChange={(event) => setField('retentionDays', Number(event.target.value))} /></label></div><p className="muted">A limpeza manual sempre exige preview e confirmação com quantidade exata.</p></section>
      </div>
      <section className="card"><div className="card-heading"><div><div className="eyebrow">TTS / SAFETY</div><h3>Proteções atuais</h3></div></div><div className="settings-list"><div><span>TTS</span><strong>Piper · pt_BR-jeff-medium · protegido</strong></div><div><span>GPU</span><strong>máximo de um modelo neural por vez</strong></div><div><span>Rede</span><strong>Core loopback · Tailscale-only</strong></div><div><span>Ações físicas</span><strong>bloqueadas sem confirmação</strong></div></div></section>
      {message && <div className="callout"><strong>Estado</strong><span>{message}</span></div>}
      <button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? 'salvando…' : 'Salvar configurações'}</button>
    </div>
  );
}

interface AudioSessionManagerProps {
  api: JarvisApiClient;
  sessions: AudioSession[];
  onDeleted: (ids: string[]) => void;
}

function defaultBefore(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function AudioSessionManager({ api, sessions, onDeleted }: AudioSessionManagerProps) {
  const [before, setBefore] = useState(defaultBefore);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [includeFailed, setIncludeFailed] = useState(true);
  const [preview, setPreview] = useState<AudioSessionDeletePreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function createPreview() {
    const statuses = [
      ...(includeCompleted ? ['completed' as const] : []),
      ...(includeFailed ? ['failed' as const] : []),
    ];
    if (statuses.length === 0) { setMessage('Selecione pelo menos um status.'); return; }
    setBusy(true); setMessage('calculando impacto…'); setConfirmation('');
    try {
      const result = await api.previewAudioSessionDeletion({ before: `${before}T00:00:00.000Z`, statuses });
      setPreview(result);
      setMessage(result.count ? `${result.count} sessão(ões) elegível(is)` : 'nenhuma sessão elegível');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'preview indisponível');
    } finally { setBusy(false); }
  }

  async function executeDelete() {
    if (!preview || confirmation !== audioSessionDeleteConfirmation(preview.count) || busy) return;
    setBusy(true); setMessage('apagando e redigindo conteúdo vinculado…');
    try {
      const result = await api.deleteAudioSessions(preview.previewId, confirmation);
      onDeleted(result.deletedSessionIds);
      setPreview(null);
      setConfirmation('');
      setMessage(`${result.deletedCount} sessão(ões) removida(s); ${result.redactedConversationCount} conversa(s) redigida(s)`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'falha na exclusão');
    } finally { setBusy(false); }
  }

  const expected = preview ? audioSessionDeleteConfirmation(preview.count) : '';
  return (
    <section className="card session-manager">
      <div className="card-heading"><div><div className="eyebrow">RETENÇÃO / PRIVACIDADE</div><h3>Limpar sessões antigas</h3></div><span className="muted">{sessions.length} carregadas</span></div>
      <p className="muted">Apenas `completed`/`failed` anteriores à data entram. Sessões ativas, gravações, Drive e linhas estruturais de auditoria ficam protegidos.</p>
      <div className="settings-form session-filters"><label><span>Antes de</span><input type="date" value={before} onChange={(event) => setBefore(event.target.value)} /></label><label className="setting-check"><input type="checkbox" checked={includeCompleted} onChange={(event) => setIncludeCompleted(event.target.checked)} /><span>completed</span></label><label className="setting-check"><input type="checkbox" checked={includeFailed} onChange={(event) => setIncludeFailed(event.target.checked)} /><span>failed</span></label></div>
      <button className="button" disabled={busy} onClick={() => void createPreview()}>Pré-visualizar exclusão</button>
      {preview && <div className="callout"><strong>Impacto: {preview.count} sessão(ões)</strong><span>{preview.byStatus.completed} completed · {preview.byStatus.failed} failed · expira em {new Date(preview.expiresAt).toLocaleTimeString('pt-BR')}</span>{preview.count > 0 && <><input aria-label="Confirmação da exclusão" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={expected} /><button className="button danger" disabled={busy || confirmation !== expected} onClick={() => void executeDelete()}>Confirmar exclusão</button></>}</div>}
      {message && <div className="muted">{message}</div>}
    </section>
  );
}

export function applyDeletedAudioSessions(sessions: AudioSession[], ids: string[]): AudioSession[] {
  return removeDeletedAudioSessions(sessions, ids);
}
