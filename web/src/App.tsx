import { useEffect, useRef, useState } from 'react';
import './app.css';
import QRCode from 'qrcode';
import {
  abortChat,
  apiMe,
  apiUrl,
  approveTool,
  createChat,
  createCredential,
  createTerminal,
  credentialLogin,
  deleteChat,
  fsMkdir,
  fsLs,
  fsRoots,
  getAuthMode,
  getChat,
  getChatRuntime,
  getDefaults,
  listCredentials,
  revokeCredential as revokeCredentialApi,
  listTerminals,
  listChats,
  getStatus,
  getTotpStatus,
  getTotpUri,
  logout,
  otpRequest,
  otpVerify,
  resetChatSession,
  setActiveChat,
  sendMessageAsync,
  totpVerify,
  updateChatSettings,
  type ChatMessage,
  type Defaults,
  type CredentialRecord,
  type ModelOption,
  type TerminalSession,
  type ReasoningEffort
} from './api';

type View =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'chat'; chatId: string };

const LAST_CHAT_KEY_PREFIX = 'codex:lastChat:';

function nowTs() {
  return Date.now();
}

const MODEL_DEFAULT_VALUE = '__default__';
const MODEL_CUSTOM_VALUE = '__custom__';
const REASONING_DEFAULT_VALUE = '__default__';
const REASONING_VALUES: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const LOCKED_SANDBOX = 'danger-full-access';
const LOCKED_APPROVAL_POLICY = 'never';

function asReasoningEffort(v: unknown): ReasoningEffort | '' {
  if (typeof v !== 'string') return '';
  const t = v.trim() as ReasoningEffort;
  return REASONING_VALUES.includes(t) ? t : '';
}

function normalizeStreamText(v: string): string {
  return v.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [sessionId, setSessionId] = useState<string>('');

  const lastChatKey = (sid: string) => `${LAST_CHAT_KEY_PREFIX}${sid}`;

  const rememberLastChat = (sid: string, chatId: string) => {
    if (!sid || !chatId) return;
    try {
      window.localStorage.setItem(lastChatKey(sid), chatId);
    } catch {
      // ignore storage errors
    }
  };

  const getRememberedChat = (sid: string): string | null => {
    try {
      return window.localStorage.getItem(lastChatKey(sid));
    } catch {
      return null;
    }
  };

  const switchToChat = (chatId: string, sid?: string) => {
    // Keep a shareable URL, but don't rely on routing.
    const u = new URL(window.location.href);
    u.searchParams.set('chat', chatId);
    window.history.replaceState(null, '', u.toString());
    const effectiveSid = sid || sessionId;
    if (effectiveSid) rememberLastChat(effectiveSid, chatId);
    void setActiveChat(chatId).catch(() => {});
    setView({ kind: 'chat', chatId });
  };

  const pickInitialChat = async (sid: string, activeChatId?: string): Promise<string> => {
    const wanted = new URLSearchParams(window.location.search).get('chat');
    if (wanted) {
      try {
        await getChat(wanted);
        return wanted;
      } catch {
        // fall through
      }
    }

    if (activeChatId) {
      try {
        await getChat(activeChatId);
        return activeChatId;
      } catch {
        // fall through
      }
    }

    const remembered = getRememberedChat(sid);
    if (remembered) {
      try {
        await getChat(remembered);
        return remembered;
      } catch {
        // fall through
      }
    }

    try {
      const chats = await listChats();
      if (chats.length > 0) {
        chats.sort((a, b) => b.updatedAt - a.updatedAt);
        return chats[0].id;
      }
    } catch {
      // ignore and create a new chat below
    }

    return createChat();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await apiMe();
      if (cancelled) return;
      if (me.ok && me.sessionId) {
        setSessionId(me.sessionId);
        const chatId = await pickInitialChat(me.sessionId, me.activeChatId);
        if (cancelled) return;
        switchToChat(chatId, me.sessionId);
      } else {
        setView({ kind: 'login' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (view.kind === 'loading') return <div className="page"><div className="card">Loading...</div></div>;
  if (view.kind === 'login') return <Login onAuthed={async () => {
    const me = await apiMe();
    if (!me.ok || !me.sessionId) {
      setView({ kind: 'login' });
      return;
    }
    setSessionId(me.sessionId);
    const chatId = await pickInitialChat(me.sessionId, me.activeChatId);
    switchToChat(chatId, me.sessionId);
  }} />;
  return <Chat chatId={view.chatId} sessionId={sessionId} onSwitchChat={(chatId) => switchToChat(chatId)} onLogout={async () => {
    await logout();
    const u = new URL(window.location.href);
    u.searchParams.delete('chat');
    window.history.replaceState(null, '', u.toString());
    setSessionId('');
    setView({ kind: 'login' });
  }} />;
}

function Login(props: { onAuthed: () => void | Promise<void> }) {
  const [mode, setMode] = useState<'otp' | 'totp'>('otp');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [status, setStatus] = useState<string>('');
  const [statusKind, setStatusKind] = useState<'info' | 'error' | 'success'>('info');
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [totpProvisioned, setTotpProvisioned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState('');
  const [credentialStatus, setCredentialStatus] = useState('');
  const [credentialStatusKind, setCredentialStatusKind] = useState<'info' | 'error' | 'success'>('info');
  const [credentialBusy, setCredentialBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getAuthMode();
      if (cancelled) return;
      if (r.ok && r.mode) setMode(r.mode);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (mode !== 'totp') return;
    (async () => {
      const r = await getTotpStatus();
      if (cancelled) return;
      if (r.ok && typeof r.provisioned === 'boolean') setTotpProvisioned(r.provisioned);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    // If provisioning got locked while this page was open, hide QR immediately.
    if (totpProvisioned) {
      setShowTotpSetup(false);
      setTotpQr(null);
    }
  }, [totpProvisioned]);

  const hintId = 'login-hint';

  const setStatusMsg = (kind: typeof statusKind, msg: string) => {
    setStatusKind(kind);
    setStatus(msg);
  };

  const verifyEnabled = otp.length === 6 && (mode === 'totp' || !!challengeId) && !busy;

  const doVerify = async () => {
    if (!verifyEnabled) return;
    setBusy(true);
    setStatusMsg('info', 'Verifying...');
    try {
      const r = mode === 'otp' ? await otpVerify(challengeId!, otp) : await totpVerify(otp);
      if (r.ok) {
        setStatusMsg('success', 'OK');
        await props.onAuthed();
      } else {
        setStatusMsg('error', `Verify failed: ${r.error || 'invalid'}`);
      }
    } catch (e: any) {
      setStatusMsg('error', `Verify failed: ${String(e?.message || e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doCredentialLogin = async () => {
    const c = credential.trim();
    if (!c || credentialBusy) return;
    setCredentialBusy(true);
    setCredentialStatus('Verifying credential...');
    setCredentialStatusKind('info');
    try {
      const r = await credentialLogin(c);
      if (r.ok) {
        setCredentialStatus('Login successful.');
        setCredentialStatusKind('success');
        setCredential('');
        await props.onAuthed();
      } else {
        setCredentialStatus(`Credential login failed: ${r.error || 'invalid credential'}`);
        setCredentialStatusKind('error');
      }
    } catch (e: any) {
      setCredentialStatus(`Credential login failed: ${String(e?.message || e)}`);
      setCredentialStatusKind('error');
    } finally {
      setCredentialBusy(false);
    }
  };

  const doTotpSetup = async () => {
    if (busy || totpProvisioned) return;
    setShowTotpSetup(true);
    if (totpQr) return;
    setBusy(true);
    setStatusMsg('info', 'Loading QR...');
    try {
      const r = await getTotpUri().catch(() => ({ ok: false } as any));
      if (!r.ok || !r.uri) {
        setStatusMsg('error', 'QR not available.');
        return;
      }
      const dataUrl = await QRCode.toDataURL(r.uri, { margin: 1, width: 240 });
      setTotpQr(dataUrl);
      setStatusMsg('success', '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="card">
        <div className="title">Codex Web Chat</div>
        <div className="subtitle">
          {mode === 'otp' ? 'OTP login (server logs the code)' : 'TOTP login (scan once in an authenticator app)'}
        </div>

        <div className="setup">
          <div className="subtitle">Credential login</div>
          <div className="row">
            <input
              className="input"
              placeholder="Paste credential token"
              value={credential}
              onChange={(e) => {
                setCredential(e.target.value);
                if (credentialStatus) setCredentialStatus('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void doCredentialLogin();
                }
              }}
            />
            <button className="btn" disabled={credentialBusy || !credential.trim()} onClick={() => void doCredentialLogin()}>
              {credentialBusy ? 'Logging in...' : 'Login with credential'}
            </button>
          </div>
          {credentialStatus ? (
            <div className={`status ${credentialStatusKind === 'error' ? 'status-error' : credentialStatusKind === 'success' ? 'status-success' : ''}`}>
              {credentialStatus}
            </div>
          ) : null}
        </div>

        {mode === 'totp' && !totpProvisioned ? (
          <div className="row">
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={doTotpSetup}
            >
              Setup Authenticator (QR)
            </button>
          </div>
        ) : null}

        {mode === 'otp' ? (
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setStatusMsg('info', 'Requesting OTP...');
                try {
                  const r = await otpRequest();
                  if (r.ok && r.challengeId) {
                    setChallengeId(r.challengeId);
                    setStatusMsg('success', 'OTP requested. Check server logs for the 6-digit code.');
                  } else {
                    setStatusMsg('error', `OTP request failed: ${r.error || 'unknown'}`);
                  }
                } catch (e: any) {
                  setStatusMsg('error', `OTP request failed: ${String(e?.message || e)}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Working...' : 'Request OTP'}
            </button>
          </div>
        ) : null}

        <div className="row">
          <label className="sr-only" htmlFor="otp-code">6-digit code</label>
          <input
            id="otp-code"
            className="input"
            placeholder="6-digit code"
            value={otp}
            onChange={(e) => {
              const digits = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
              setOtp(digits);
              if (status) setStatusMsg('info', '');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void doVerify();
              }
            }}
            inputMode="numeric"
            maxLength={6}
            aria-describedby={hintId}
            aria-invalid={statusKind === 'error' ? 'true' : 'false'}
          />
          <button
            className="btn"
            disabled={!verifyEnabled}
            onClick={doVerify}
          >
            {busy ? 'Working...' : 'Verify'}
          </button>
        </div>

        <div className="hint" id={hintId}>
          {mode === 'otp'
            ? 'After clicking Request OTP, check the backend console for the code.'
            : totpProvisioned
              ? 'TOTP is already provisioned. Enter the 6-digit code from your authenticator app.'
              : 'Enter the 6-digit code from your authenticator app. (QR setup is only available once)'}
        </div>
        {status ? <div className={`status ${statusKind === 'error' ? 'status-error' : statusKind === 'success' ? 'status-success' : ''}`}>{status}</div> : null}
        {mode === 'totp' && showTotpSetup ? (
          <div className="setup">
            <div className="subtitle">Scan once with an authenticator app.</div>
            {totpQr ? (
              <div className="qr">
                <img src={totpQr} width={240} height={240} alt="TOTP QR" />
              </div>
            ) : (
              <div className="status">QR is not available (it may be disabled or already provisioned).</div>
            )}
            <div className="row">
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  if (totpProvisioned) return;
                  await doTotpSetup();
                }}
              >
                {busy ? 'Working...' : 'Reload QR'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowTotpSetup(false);
                  setTotpQr(null);
                }}
              >
                Hide
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Chat(props: { chatId: string; sessionId: string; onSwitchChat: (chatId: string) => void | Promise<void>; onLogout: () => void | Promise<void> }) {
  const [chatList, setChatList] = useState<{ id: string; updatedAt: number; createdAt: number; preview?: string }[]>([]);
  const [terminalList, setTerminalList] = useState<TerminalSession[]>([]);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [credentialListBusy, setCredentialListBusy] = useState(false);
  const [chatListBusy, setChatListBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');
  const [creatingCredential, setCreatingCredential] = useState(false);
  const [createdCredential, setCreatedCredential] = useState('');
  const [activeTerminal, setActiveTerminal] = useState<TerminalSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ id: string; message?: string; command?: string[]; cwd?: string } | null>(null);
  const [settings, setSettings] = useState<{
    model?: string;
    reasoningEffort?: ReasoningEffort;
    cwd?: string;
    sandbox?: string;
    approvalPolicy?: string;
  }>({});
  const [modelInput, setModelInput] = useState('');
  const [reasoningEffortInput, setReasoningEffortInput] = useState<ReasoningEffort | ''>('');
  const [cwdInput, setCwdInput] = useState('');
  const [uiStatus, setUiStatus] = useState<string>('');
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [cwdRoots, setCwdRoots] = useState<{ path: string; label: string }[]>([]);
  const [cwdPath, setCwdPath] = useState<string>('');
  const [cwdEntries, setCwdEntries] = useState<{ name: string; type: string }[]>([]);
  const [cwdNewDirName, setCwdNewDirName] = useState('');
  const [cwdPickerErr, setCwdPickerErr] = useState<string>('');
  const [lastUpdateAt, setLastUpdateAt] = useState<number>(0);
  const [streamStatus, setStreamStatus] = useState<'connected' | 'reconnecting'>('connected');
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [mobileChatListOpen, setMobileChatListOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number>(0);
  const resumeRebuildRef = useRef<boolean>(false);
  const pollTimerRef = useRef<number | null>(null);
  const startTurnRef = useRef<boolean>(false);
  const busyRef = useRef<boolean>(false);
  const terminalListRefreshSeqRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => setIsMobileLayout(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!isMobileLayout) setMobileChatListOpen(false);
  }, [isMobileLayout]);

  const refreshTerminals = async () => {
    const seq = ++terminalListRefreshSeqRef.current;
    try {
      const terminalResult = await listTerminals();
      if (seq !== terminalListRefreshSeqRef.current) return [];
      setTerminalList(terminalResult);
      return terminalResult;
    } catch (e) {
      console.error(e);
      return [];
    }
  };

  const refreshChatList = async () => {
    let chats: { id: string; updatedAt: number; createdAt: number; preview?: string }[] = [];
    try {
      setChatListBusy(true);
      const chatResult = await listChats();
      void refreshTerminals();
      chats = chatResult;
      setChatList(chats);
    } catch (e) {
      // ignore list refresh errors
      console.error(e);
    } finally {
      setChatListBusy(false);
    }
    return chats;
  };

  const refreshCredentials = async () => {
    try {
      setCredentialListBusy(true);
      const list = await listCredentials();
      setCredentials(list);
    } catch {
      // ignore list refresh errors
    } finally {
      setCredentialListBusy(false);
    }
  };

  const createCredentialNow = async () => {
    if (creatingCredential) return;
    setCreatedCredential('');
    setCreatingCredential(true);
    try {
      const r = await createCredential(credentialInput.trim() || undefined);
      if (!r.ok || !r.credential) {
        setErr(r.error || 'create_credential_failed');
        return;
      }
      setCreatedCredential(r.credential);
      setCredentialInput('');
      await refreshCredentials();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setCreatingCredential(false);
    }
  };

  const revokeCredential = async (credentialId: string) => {
    if (!window.confirm('Revoke this credential?')) return;
    try {
      await revokeCredentialApi(credentialId);
      await refreshCredentials();
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  const copyCredentialToClipboard = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  const addSystem = (t: string) => {
    setMessages((m) => [
      ...m,
      { id: `local-sys-${nowTs()}`, role: 'system', text: t, createdAt: nowTs() }
    ]);
  };

  const openChatListMobile = () => {
    setMobileChatListOpen(true);
  };

  const removeChat = async (chatId: string) => {
    if (!window.confirm('Delete this session and remove all its messages?')) {
      return;
    }
    const wasActive = chatId === props.chatId;
    try {
      await deleteChat(chatId);
      const chats = await refreshChatList();
      if (!wasActive) return;

      const next = chats.find((c) => c.id !== chatId);
      if (next) {
        void props.onSwitchChat(next.id);
        return;
      }

      const newId = await createChat();
      void props.onSwitchChat(newId);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  const createNewTerminal = async () => {
    try {
      const cwd = settings.cwd || defaults?.cwd || undefined;
      const r = await createTerminal(cwd);
      if (!r.ok || !r.terminal?.terminalId) {
        setErr(r.error || 'create_terminal_failed');
        return;
      }

      const terminal = r.terminal;
      const normalizedTerminal: TerminalSession = {
        terminalId: terminal.terminalId,
        cwd: terminal.cwd || defaults?.cwd || '',
        createdAt: terminal.createdAt || nowTs(),
        status: terminal.status || 'running'
      };
      setActiveTerminal(normalizedTerminal);
      setTerminalList((prev) => {
        const cleaned = prev.filter((item) => item.terminalId !== terminal.terminalId);
        return [
          normalizedTerminal,
          ...cleaned
        ].slice(0, 20);
      });
      addSystem(`Terminal created: ${terminal.terminalId} (cwd=${terminal.cwd || 'default'})`);
      void refreshTerminals();
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  const openTerminal = (terminal: TerminalSession) => {
    setActiveTerminal(terminal);
    addSystem(`Open terminal: ${terminal.terminalId} (cwd=${terminal.cwd || 'default'})`);
  };

  const selectChat = (chatId: string) => {
    if (chatId !== props.chatId) {
      void props.onSwitchChat(chatId);
    }
    setMobileChatListOpen(false);
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const closeStream = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  };

  const startPolling = () => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = window.setInterval(async () => {
      try {
        const [c2, rt2] = await Promise.all([getChat(props.chatId), getChatRuntime(props.chatId)]);
        setMessages(c2.messages);
        const { sandbox: _s, approvalPolicy: _a, ...savedSettings } = c2.settings || {};
        setSettings(savedSettings);
        if (rt2?.ok && typeof rt2.updatedAt === 'number') setLastUpdateAt(rt2.updatedAt);
        if (rt2.ok && rt2.status !== 'running') {
          stopPolling();
          setBusy(false);
          closeStream();
          setStreamStatus('connected');
        }
      } catch {
        // keep trying while reconnecting
      }
    }, 1500);
  };

  const connectStream = (after: number) => {
    closeStream();
    setStreamStatus('reconnecting');
    // Use `after=` for initial subscribe; server will prefer Last-Event-ID on automatic reconnect.
    esRef.current = new EventSource(
      apiUrl(`/api/chats/${encodeURIComponent(props.chatId)}/stream?after=${Math.max(0, after || 0)}`)
    );
    const es = esRef.current;

    es.onopen = () => {
      setStreamStatus('connected');
    };

    const onAny = (ev: MessageEvent) => {
      const lid = Number((ev as any).lastEventId || '0');
      if (Number.isFinite(lid)) lastEventIdRef.current = lid;
    };

    es.addEventListener('start', (ev: any) => {
      onAny(ev);
      try {
        const data = JSON.parse(ev.data || '{}');
        const mid = String(data.assistantMessageId || '');
        if (!mid) return;
        setMessages((m) => {
          const idx = m.findIndex((x) => x.id === mid);
          if (idx === -1) return [...m, { id: mid, role: 'assistant', text: '', createdAt: nowTs() }];
          if (!resumeRebuildRef.current) return m;
          const copy = [...m];
          copy[idx] = { ...copy[idx], text: '' };
          return copy;
        });
        resumeRebuildRef.current = false;
      } catch {}
    });

    es.addEventListener('delta', (ev: any) => {
      onAny(ev);
      try {
        const data = JSON.parse(ev.data || '{}');
        const mid = String(data.assistantMessageId || '');
        const t = normalizeStreamText(String(data.text || ''));
        if (!mid || !t) return;
        setMessages((m) => {
          const idx = m.findIndex((x) => x.id === mid);
          if (idx === -1) return m;
          const copy = [...m];
          copy[idx] = { ...copy[idx], text: copy[idx].text + t };
          return copy;
        });
      } catch {}
    });

    es.addEventListener('approval_request', (ev: any) => {
      onAny(ev);
      try {
        const data = JSON.parse(ev.data || '{}');
        setApproval(data);
      } catch {}
    });

    const finish = async (kind: 'done' | 'turn_error', ev: any) => {
      onAny(ev);
      setBusy(false);
      closeStream();
      setStreamStatus('connected');
      stopPolling();
      if (kind === 'turn_error') {
        try {
          const data = JSON.parse(ev.data || '{}');
          setErr(String(data.message || 'codex_error'));
        } catch {
          setErr('codex_error');
        }
      }
      // Sync with server state once per turn completion for correctness.
      try {
        const [c2, rt2] = await Promise.all([getChat(props.chatId), getChatRuntime(props.chatId)]);
        setMessages(c2.messages);
        const { sandbox: _s, approvalPolicy: _a, ...savedSettings } = c2.settings || {};
        setSettings(savedSettings);
        if (rt2?.ok && typeof rt2.updatedAt === 'number') setLastUpdateAt(rt2.updatedAt);
        void refreshChatList();
      } catch {}
    };

    es.addEventListener('done', (ev: any) => void finish('done', ev));
    es.addEventListener('turn_error', (ev: any) => void finish('turn_error', ev));
    // Backward-compat for older servers.
    es.addEventListener('error', (ev: any) => {
      // Distinguish SSE event "error" from transport error: if data is JSON, treat as turn error.
      if (ev?.data) void finish('turn_error', ev);
    });

    es.addEventListener('error', () => {
      // Transport-level error; EventSource will retry automatically.
      setStreamStatus('reconnecting');
      if (busyRef.current) startPolling();
    });
  };

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (busy) startPolling();
    else stopPolling();
  }, [busy]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      setBusy(false);
      setApproval(null);
      setStreamStatus('connected');
      setQueuedPrompts([]);
      startTurnRef.current = false;
      const chat = await getChat(props.chatId);
      if (cancelled) return;
      setMessages(chat.messages);
      const { sandbox: _s, approvalPolicy: _a, ...savedSettings } = chat.settings || {};
      setSettings(savedSettings);
      setModelInput(savedSettings.model || '');
      setReasoningEffortInput(asReasoningEffort(savedSettings.reasoningEffort));
      setCwdInput(savedSettings.cwd || '');
      void refreshChatList();
      void refreshCredentials();

      const d = await getDefaults().catch(() => ({ ok: false } as any));
      if (!cancelled && d.ok && d.defaults) {
        const modelOptions = Array.isArray(d.defaults.modelOptions)
          ? d.defaults.modelOptions.filter((x: unknown): x is ModelOption => typeof (x as any)?.slug === 'string')
          : [];
        const reasoningEffortOptions = Array.isArray(d.defaults.reasoningEffortOptions)
          ? d.defaults.reasoningEffortOptions
            .map((x: unknown) => asReasoningEffort(x))
            .filter((x: unknown): x is ReasoningEffort => Boolean(x))
          : [];
        setDefaults({
          ...d.defaults,
          sandbox: LOCKED_SANDBOX,
          approvalPolicy: LOCKED_APPROVAL_POLICY,
          reasoningEffort: asReasoningEffort(d.defaults.reasoningEffort) || null,
          modelOptions,
          reasoningEffortOptions
        });
      }

      const rt = await getChatRuntime(props.chatId).catch(() => ({ ok: false } as any));
      if (cancelled) return;
      if (rt?.ok && typeof rt.updatedAt === 'number') setLastUpdateAt(rt.updatedAt);
      if (rt?.ok && rt.status === 'running') {
        setBusy(true);
        // If a browser refresh happens mid-run, chat already contains partial text.
        // Rebuild the in-progress assistant message from the stream to avoid double-appends.
        resumeRebuildRef.current = true;
        lastEventIdRef.current = 0;
        connectStream(0);
        startPolling();
      }
    })().catch((e) => setErr(String(e?.message || e)));
    return () => {
      cancelled = true;
      stopPolling();
      closeStream();
    };
  }, [props.chatId]);

  useEffect(() => {
    // Persist user preference; default collapsed to prioritize chat.
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('controlsOpen');
      if (raw === '1') setControlsOpen(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('controlsOpen', controlsOpen ? '1' : '0');
    }
  }, [controlsOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const applySettings = async (patch: any, local: Partial<typeof settings>, statusText?: string) => {
    if (patch && typeof patch === 'object') {
      if ('sandbox' in patch || 'approvalPolicy' in patch) {
        return;
      }
    }
    try {
      setErr(null);
      setUiStatus(statusText || 'Updating...');
      await updateChatSettings(props.chatId, patch);
      setSettings((s) => ({ ...s, ...local }));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setUiStatus('');
    }
  };

  const openCwdPicker = async () => {
    try {
      setCwdPickerErr('');
      setCwdPickerOpen(true);
      const r = await fsRoots();
      if (r.ok && r.roots) setCwdRoots(r.roots);
      const start = settings.cwd || defaults?.cwd || '';
      const l = await fsLs(start);
      if (!l.ok) {
        setCwdPickerErr(l.error || 'ls_failed');
        return;
      }
      setCwdPath(l.path || start);
      setCwdEntries(l.entries || []);
    } catch (e: any) {
      setCwdPickerErr(String(e?.message || e));
    }
  };

  const navCwd = async (p: string) => {
    setCwdPickerErr('');
    const l = await fsLs(p);
    if (!l.ok) {
      setCwdPickerErr(l.error || 'ls_failed');
      return;
    }
    setCwdPath(l.path || p);
    setCwdEntries(l.entries || []);
  };

  const chooseCwd = async (p: string) => {
    setCwdInput(p);
    await applySettings({ cwd: p }, { cwd: p }, `CWD -> ${p}`);
    setCwdPickerOpen(false);
  };

  const createCwdDir = async () => {
    const name = cwdNewDirName.trim();
    if (!name) {
      setCwdPickerErr('Directory name is required.');
      return;
    }
    if (/[/\\\0]/.test(name)) {
      setCwdPickerErr('Invalid directory name.');
      return;
    }
    if (!cwdPath) {
      setCwdPickerErr('Current directory is not available.');
      return;
    }

    const target = `${cwdPath.replace(/\/+$/, '')}/${name}`;
    try {
      setCwdPickerErr('');
      const r = await fsMkdir(target);
      if (!r.ok) {
        setCwdPickerErr(r.error || 'mkdir_failed');
        return;
      }
      setCwdNewDirName('');
      await navCwd(cwdPath);
    } catch (e: any) {
      setCwdPickerErr(String(e?.message || e));
    }
  };

  const startTurn = async (promptText: string, opts?: { fromQueue?: boolean; restoreText?: string }) => {
    if (startTurnRef.current) return;
    startTurnRef.current = true;

    setErr(null);
    setBusy(true);
    setApproval(null);

    const userMsg: ChatMessage = { id: `local-user-${nowTs()}`, role: 'user', text: promptText, createdAt: nowTs() };
    setMessages((m) => [...m, userMsg]);

    try {
      const r = await sendMessageAsync(props.chatId, promptText);
      if (!r.ok || !r.assistantMessageId) {
        setBusy(false);
        setErr(r.error || 'send_failed');
        // Roll back optimistic local message; server didn't accept the turn.
        setMessages((m) => m.filter((x) => x.id !== userMsg.id));
        if (opts?.fromQueue) {
          setQueuedPrompts((q) => [promptText, ...q]);
        } else if (opts?.restoreText) {
          setText(opts.restoreText);
        }
        return;
      }

      // Insert assistant placeholder with server id so stream deltas can append reliably.
      const assistantId = r.assistantMessageId;
      setMessages((m) => [...m, { id: assistantId, role: 'assistant', text: '', createdAt: nowTs() }]);
      void refreshChatList();

      // (Re)subscribe stream from start of this turn.
      resumeRebuildRef.current = false;
      lastEventIdRef.current = 0;
      connectStream(0);
      startPolling();

      // Safety: if the stream finishes while disconnected, polling will clear `busy`.
      window.setTimeout(async () => {
        try {
          const rt = await getChatRuntime(props.chatId);
          if (rt.ok && typeof rt.updatedAt === 'number') setLastUpdateAt(rt.updatedAt);
          if (rt.ok && rt.status !== 'running') setBusy(false);
        } catch {}
      }, 1500);
    } finally {
      startTurnRef.current = false;
    }
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Escape: `//foo` -> send `/foo` literally (bypasses local slash-commands).
    const escapedLeadingSlash = trimmed.startsWith('//');
    const rawPromptText = escapedLeadingSlash ? trimmed.slice(1) : trimmed;
    const isSlashCommand = rawPromptText.startsWith('/') && !escapedLeadingSlash;
    if (isSlashCommand) {
      const [cmdRaw, ...argParts] = rawPromptText.slice(1).trim().split(/\s+/);
      const cmd = (cmdRaw || '').toLowerCase();
      const args = argParts.join(' ').trim();
      if (cmd === 'status' || (cmd === 'web' && args.toLowerCase() === 'status')) {
        addSystem('Status command is unavailable in this app.');
        setText('');
        return;
      }
      if (cmd === 'resume') {
        const status = await getStatus();
        if (!status.ok || !status.status?.session?.activeChatId) {
          addSystem('No resumable active chat found.');
          setText('');
          return;
        }
        const target = status.status.session.activeChatId;
        if (target) {
          selectChat(target);
          addSystem(`Resumed chat: ${target}`);
        } else {
          addSystem('No resumable active chat found.');
        }
        setText('');
        return;
      }
      if (cmd === 'web' && args.toLowerCase() === 'help') {
        addSystem('Web commands: /resume, /web help');
        setText('');
        return;
      }
    }

    const promptText = rawPromptText;
    setText('');

    if (busy || startTurnRef.current) {
      setQueuedPrompts((q) => [...q, promptText]);
      return;
    }

    await startTurn(promptText, { restoreText: trimmed });
  };

  useEffect(() => {
    if (busy || startTurnRef.current || queuedPrompts.length === 0) return;
    const [next, ...rest] = queuedPrompts;
    setQueuedPrompts(rest);
    void startTurn(next, { fromQueue: true });
  }, [busy, queuedPrompts]);

  const chatOptionLabel = (chat: { id: string; preview?: string; updatedAt: number }) => {
    const shortId = chat.id.slice(0, 6);
    const preview = (chat.preview || '').replace(/\s+/g, ' ').trim();
    if (preview) return `${shortId}  ${preview.slice(0, 40)}`;
    return `${shortId}  ${new Date(chat.updatedAt).toLocaleTimeString()}`;
  };
  const sessionTabLabel = (chat: { id: string; preview?: string; updatedAt: number }) => {
    const preview = (chat.preview || '').replace(/\s+/g, ' ').trim();
    if (preview) return preview.slice(0, 42);
    return new Date(chat.updatedAt).toLocaleTimeString();
  };
  const terminalOptionLabel = (terminal: TerminalSession) => {
    const name = terminal.terminalId.slice(0, 10);
    const cwd = terminal.cwd || 'default';
    return `${name}  ${cwd}`;
  };
  const credentialOptionLabel = (credential: CredentialRecord) => {
    const label = credential.label?.trim();
    const usage = credential.usedCount ? `used ${credential.usedCount}x` : 'unused';
    const meta = [label || credential.id, usage].filter(Boolean).join(' · ');
    return meta;
  };

  const modelOptions = defaults?.modelOptions || [];
  const modelInputTrimmed = modelInput.trim();
  const modelSelectValue = !modelInputTrimmed
    ? MODEL_DEFAULT_VALUE
    : modelOptions.some((m) => m.slug === modelInputTrimmed)
      ? modelInputTrimmed
      : MODEL_CUSTOM_VALUE;
  const modelForEffort = modelInputTrimmed || settings.model || defaults?.model || '';
  const selectedModelOption = modelOptions.find((m) => m.slug === modelForEffort);
  const reasoningEffortOptions = (
    selectedModelOption?.reasoningEfforts?.length
      ? selectedModelOption.reasoningEfforts
      : defaults?.reasoningEffortOptions || []
  ).filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <div className="page page-chat">
      <div className={`shell chat-layout ${mobileChatListOpen ? 'sidebar-open' : ''}`}>
        {isMobileLayout && mobileChatListOpen ? (
          <button className="sidebar-backdrop" aria-label="Close chat list" onClick={() => setMobileChatListOpen(false)} />
        ) : null}

        <aside className="chat-sidebar">
          <div className="sidebar-head">
            <div className="sidebar-title">会话列表</div>
            {isMobileLayout ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setMobileChatListOpen(false)}>
                返回
              </button>
            ) : null}
          </div>
          <div className="session-tabs-scroll">
            {chatList.length === 0 && terminalList.length === 0 ? (
              <div className="session-tab session-tab-empty">No sessions</div>
            ) : null}
            {chatList.length > 0 ? chatList.map((chat) => (
              <div key={chat.id} className="session-tab-row">
                <button
                  className={`session-tab ${chat.id === props.chatId ? 'active' : ''}`}
                  disabled={chatListBusy}
                  type="button"
                  title={chatOptionLabel(chat)}
                  onClick={() => selectChat(chat.id)}
                >
                  <span className="session-tab-id">{chat.id.slice(0, 6)}</span>
                  <span className="session-tab-preview">{sessionTabLabel(chat)}</span>
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={chatListBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeChat(chat.id);
                  }}
                >
                  Delete
                </button>
              </div>
            )) : null}
            {terminalList.length > 0 ? (
              <>
                <div className="session-tab session-tab-empty" style={{ margin: '6px 0 2px' }}>
                  Terminal sessions
                </div>
                {terminalList.map((terminal) => (
                  <div key={terminal.terminalId} className="session-tab-row">
                    <button
                      className={`session-tab ${terminal.terminalId === activeTerminal?.terminalId ? 'active' : ''}`}
                      type="button"
                      disabled={chatListBusy}
                      title={terminalOptionLabel(terminal)}
                      onClick={() => openTerminal(terminal)}
                    >
                      <span className="session-tab-id">{terminal.terminalId.slice(0, 6)}</span>
                      <span className="session-tab-preview">{terminalOptionLabel(terminal)}</span>
                    </button>
                  </div>
                ))}
              </>
            ) : null}
            <div className="session-tab session-tab-empty" style={{ margin: '10px 0 4px' }}>
              Access credentials
            </div>
            <div className="session-switch">
              <input
                className="input input-sm"
                placeholder="Credential label (optional)"
                value={credentialInput}
                disabled={creatingCredential || credentialListBusy}
                onChange={(e) => setCredentialInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void createCredentialNow();
                  }
                }}
              />
              <button
                className="btn btn-secondary btn-sm"
                disabled={creatingCredential || credentialListBusy}
                onClick={() => void createCredentialNow()}
              >
                {creatingCredential ? 'Creating...' : 'Create'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={credentialListBusy}
                onClick={() => void refreshCredentials()}
              >
                Reload
              </button>
            </div>
            {createdCredential ? (
              <div className="status status-success" style={{ margin: '4px 6px 8px', wordBreak: 'break-all' }}>
                New credential:
                <div className="session-tab-preview" style={{ marginTop: 4 }}>{createdCredential}</div>
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 6 }}
                  onClick={() => void copyCredentialToClipboard(createdCredential)}
                >
                  Copy
                </button>
              </div>
            ) : null}
            {credentials.length === 0 ? (
              <div className="session-tab session-tab-empty">No credentials</div>
            ) : (
              credentials.map((credential) => (
                <div key={credential.id} className="session-tab-row">
                  <button
                    className="session-tab"
                    type="button"
                    disabled={credentialListBusy}
                    title={credentialOptionLabel(credential)}
                  >
                    <span className="session-tab-id">{credential.id.slice(0, 6)}</span>
                    <span className="session-tab-preview">{credentialOptionLabel(credential)}</span>
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    disabled={credentialListBusy}
                    onClick={() => void revokeCredential(credential.id)}
                  >
                    Revoke
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="session-switch">
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                try {
                  const newChatId = await createChat();
                  void refreshChatList();
                  selectChat(newChatId);
                } catch (e: any) {
                  setErr(String(e?.message || e));
                }
              }}
            >
              New
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void createNewTerminal()}
            >
              New Terminal
            </button>
            <button className="btn btn-secondary btn-sm" disabled={chatListBusy} onClick={() => void refreshChatList()}>
              Reload
            </button>
          </div>
        </aside>

        <section className="chat-main">
          <div className="topbar">
            {isMobileLayout ? (
              <button className="btn btn-secondary btn-sm mobile-chat-btn" onClick={openChatListMobile}>
                聊天
              </button>
            ) : null}
            <div className="title">Codex</div>
            <div className="topmeta">
              <span className="badge badge-tight">{props.chatId.slice(0, 6)}</span>
              {busy ? <span className="badge badge-tight badge-running">Running</span> : <span className="badge badge-tight">Idle</span>}
            </div>
            <div className="badge">
              {settings.model ? `model=${settings.model}` : 'model=default'}{' '}
              {settings.reasoningEffort ? `effort=${settings.reasoningEffort}` : ''}{' '}
              {`sandbox=${defaults?.sandbox || LOCKED_SANDBOX}`}{' '}
              {`approval=${defaults?.approvalPolicy || LOCKED_APPROVAL_POLICY}`}{' '}
              {settings.cwd ? `cwd=${settings.cwd}` : ''}
            </div>
            <div className="spacer" />
            <button className="btn btn-secondary btn-sm" onClick={() => setControlsOpen((v) => !v)}>
              Settings
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!busy}
              onClick={async () => {
                try {
                  await abortChat(props.chatId);
                  addSystem('OK: abort requested');
                  startPolling();
                } catch (e: any) {
                  setErr(String(e?.message || e));
                }
              }}
            >
              Abort
            </button>
            <button className="btn btn-secondary" onClick={() => props.onLogout()}>
              Logout
            </button>
          </div>
        <div className={`controls ${controlsOpen ? 'open' : 'closed'}`}>
          <div className="ctl">
            <div className="ctl-label">Model</div>
            <select
              className="input input-sm"
              value={modelSelectValue}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                if (v === MODEL_DEFAULT_VALUE) {
                  setModelInput('');
                  return;
                }
                if (v === MODEL_CUSTOM_VALUE) return;
                setModelInput(v);
              }}
            >
              <option value={MODEL_DEFAULT_VALUE}>Default ({defaults?.model || 'auto'})</option>
              {modelOptions.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.displayName}
                </option>
              ))}
              <option value={MODEL_CUSTOM_VALUE}>Custom...</option>
            </select>
            {modelSelectValue === MODEL_CUSTOM_VALUE ? (
              <input
                className="input input-sm"
                placeholder="Custom model id"
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                disabled={busy}
              />
            ) : null}
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                const v = modelInput.trim();
                if (!v) return applySettings({ model: null }, { model: undefined }, 'Model -> default');
                return applySettings({ model: v }, { model: v }, `Model -> ${v}`);
              }}
            >
              Apply
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setModelInput('');
                void applySettings({ model: null }, { model: undefined }, 'Model -> default');
              }}
            >
              Default
            </button>
          </div>

          <div className="ctl">
            <div className="ctl-label">Reasoning Effort</div>
            <select
              className="input input-sm"
              value={reasoningEffortInput || REASONING_DEFAULT_VALUE}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                if (v === REASONING_DEFAULT_VALUE) {
                  setReasoningEffortInput('');
                  return;
                }
                setReasoningEffortInput(asReasoningEffort(v));
              }}
            >
              <option value={REASONING_DEFAULT_VALUE}>Default ({defaults?.reasoningEffort || 'model default'})</option>
              {reasoningEffortOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                if (!reasoningEffortInput) {
                  return applySettings(
                    { reasoningEffort: null },
                    { reasoningEffort: undefined },
                    'Reasoning -> default'
                  );
                }
                return applySettings(
                  { reasoningEffort: reasoningEffortInput },
                  { reasoningEffort: reasoningEffortInput },
                  `Reasoning -> ${reasoningEffortInput}`
                );
              }}
            >
              Apply
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setReasoningEffortInput('');
                void applySettings(
                  { reasoningEffort: null },
                  { reasoningEffort: undefined },
                  'Reasoning -> default'
                );
              }}
            >
              Default
            </button>
          </div>

          <div className="ctl">
            <div className="ctl-label">Execution policy (locked)</div>
            <div className="badge badge-tight">sandbox={LOCKED_SANDBOX}</div>
            <div className="badge badge-tight">approval={LOCKED_APPROVAL_POLICY}</div>
          </div>

          <div className="ctl">
            <div className="ctl-label">CWD</div>
            <input
              className="input input-sm"
              placeholder={defaults?.cwd || 'default'}
              value={cwdInput}
              onChange={(e) => setCwdInput(e.target.value)}
              disabled={busy}
            />
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void openCwdPicker()}>
              Browse
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                const v = cwdInput.trim();
                if (!v) return applySettings({ cwd: null }, { cwd: undefined }, 'CWD -> default');
                return applySettings({ cwd: v }, { cwd: v }, `CWD -> ${v}`);
              }}
            >
              Apply
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setCwdInput('');
                void applySettings({ cwd: null }, { cwd: undefined }, 'CWD -> default');
              }}
            >
              Default
            </button>
          </div>

          <div className="ctl ctl-right">
            <div className="ctl-label">Session</div>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={async () => {
                try {
                  await resetChatSession(props.chatId);
                  addSystem('OK: reset chat codex session');
                } catch (e: any) {
                  setErr(String(e?.message || e));
                }
              }}
            >
              Reset
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!busy}
              onClick={async () => {
                try {
                  await abortChat(props.chatId);
                  addSystem('OK: abort requested');
                  startPolling();
                } catch (e: any) {
                  setErr(String(e?.message || e));
                }
              }}
            >
              Abort
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setMessages([])}
            >
              Clear UI
            </button>
          </div>
        </div>

        {cwdPickerOpen ? (
          <div className="cwdpicker">
            <div className="cwdpicker-head">
              <div className="cwdpicker-title">Select CWD</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setCwdPickerOpen(false)}>Close</button>
            </div>
            <div className="cwdpicker-path">{cwdPath || '(unknown)'}</div>
            {cwdPickerErr ? <div className="status">{cwdPickerErr}</div> : null}
            <div className="cwdpicker-roots">
              {cwdRoots.map((r) => (
                <button key={r.path} className="btn btn-secondary btn-sm" onClick={() => void navCwd(r.path)}>
                  {r.label}
                </button>
              ))}
            </div>
            <div className="cwdpicker-actions">
              <input
                className="input input-sm cwdpicker-input"
                placeholder="New folder name"
                value={cwdNewDirName}
                onChange={(e) => setCwdNewDirName(e.target.value)}
                disabled={busy}
              />
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy || !cwdPath || !cwdNewDirName.trim()}
                onClick={() => void createCwdDir()}
              >
                New folder
              </button>
              <button className="btn btn-secondary btn-sm" disabled={!cwdPath} onClick={() => void chooseCwd(cwdPath)}>
                Use This Directory
              </button>
            </div>
            <div className="cwdpicker-list">
              {cwdEntries.filter((e) => e.type === 'dir').map((e) => (
                <button
                  key={e.name}
                  className="cwdpicker-item"
                  onClick={() => void navCwd((cwdPath ? cwdPath.replace(/\/+$/, '') : '') + '/' + e.name)}
                >
                  <span className="cwdpicker-icon">dir</span>
                  <span className="cwdpicker-name">{e.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeTerminal ? (
          <div className="terminal-panel">
            <div className="terminal-panel-head">
              <div className="terminal-panel-title">
                <span>Active terminal</span>
                <span className="terminal-panel-id">{activeTerminal.terminalId}</span>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => setActiveTerminal(null)}
              >
                Close
              </button>
            </div>
            <div className="terminal-panel-grid">
              <div className="muted">CWD</div>
              <div>{activeTerminal.cwd || 'default'}</div>
              <div className="muted">Status</div>
              <div>{activeTerminal.status || 'running'}</div>
              <div className="muted">Created</div>
              <div>{new Date(activeTerminal.createdAt).toLocaleString()}</div>
            </div>
            <div className="row row-tight">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => void copyCredentialToClipboard(activeTerminal.terminalId)}
              >
                Copy terminal id
              </button>
            </div>
          </div>
        ) : null}

        <div className="chat">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="role">{m.role}</div>
              <pre className="bubble">{normalizeStreamText(m.text)}</pre>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
            className="textarea"
            placeholder="Ask Codex..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              // Chat-style composer: Enter sends, Shift+Enter makes a newline.
              const inComposition = composing || e.nativeEvent.isComposing || e.key === 'Process';
              if (inComposition) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn" disabled={text.trim().length === 0} onClick={() => void send()}>
            {busy ? 'Queue' : 'Send'}
          </button>
        </div>
        <div className="footnote">
          Enter to send, Shift+Enter for newline.
          {queuedPrompts.length > 0 ? <span className="muted"> (queued={queuedPrompts.length})</span> : null}
          {uiStatus ? <span className="muted"> ({uiStatus})</span> : null}
          {busy ? (
            <span className="muted">
              {' '}
              (running, stream={streamStatus}, last update {lastUpdateAt ? Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000)) : '?'}s ago)
            </span>
          ) : null}
        </div>
        {queuedPrompts.length > 0 ? (
          <div className="queue-panel">
            <div className="queue-head">
              <div className="queue-title">Queued prompts</div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setQueuedPrompts([])}
              >
                Clear queue
              </button>
            </div>
            <div className="queue-list">
              {queuedPrompts.map((prompt, idx) => (
                <div className="queue-item" key={`queue-${idx}-${prompt.length}`}>
                  <div className="queue-idx">#{idx + 1}</div>
                  <pre className="queue-text">{normalizeStreamText(prompt)}</pre>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setQueuedPrompts((q) => q.filter((_x, i) => i !== idx))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {err ? <div className="error">{err}</div> : null}

        {approval ? (
          <div className="approvalbar">
            <div className="approvalbar-title">Approval needed</div>
            <div className="approvalbar-sub">cwd: {approval.cwd || '(unknown)'}</div>
            <pre className="bubble">{(approval.command || []).join(' ') || approval.message || '(no details)'}</pre>
            <div className="row row-tight">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    await approveTool(props.chatId, approval.id, 'approved');
                    setApproval(null);
                  } catch (e: any) {
                    setErr(String(e?.message || e));
                  }
                }}
              >
                Approve
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await approveTool(props.chatId, approval.id, 'approved_for_session');
                    setApproval(null);
                  } catch (e: any) {
                    setErr(String(e?.message || e));
                  }
                }}
              >
                Approve (session)
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await approveTool(props.chatId, approval.id, 'denied');
                    setApproval(null);
                  } catch (e: any) {
                    setErr(String(e?.message || e));
                  }
                }}
              >
                Deny
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await approveTool(props.chatId, approval.id, 'abort');
                    setApproval(null);
                    startPolling();
                  } catch (e: any) {
                    setErr(String(e?.message || e));
                  }
                }}
              >
                Abort
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
    </div>
  );
}
