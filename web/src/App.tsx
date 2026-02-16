import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './app.css';
import QRCode from 'qrcode';
import TerminalPanel from './TerminalPanel';
import {
  abortChat,
  apiMe,
  apiUrl,
  approveTool,
  createChat,
  createTerminal,
  deleteChat,
  fsMkdir,
  fsLs,
  fsRoots,
  getChat,
  getChatRuntime,
  getDefaults,
  listTerminals,
  listChats,
  compactChat,
  getStatus,
  getTotpStatus,
  getTotpUri,
  logout,
  resetChatSession,
  setActiveChat,
  sendMessageAsync,
  totpVerify,
  updateChatSettings,
  type ChatMessage,
  type CliStatus,
  type Defaults,
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
const QUEUED_PROMPTS_KEY_PREFIX = 'codex:queuedPrompts:';
const FULLSCREEN_DESKTOP_KEY = 'codex:fullscreenDesktop';
const INSTANCE_OPTIONS: { label: string; origin: string; path: string }[] = [
  { label: 'conknow.cc', origin: 'https://conknow.cc', path: '/codex' },
  { label: 'conknow.app', origin: 'https://www.conknow.app', path: '/codex' }
];
const AGENT_PROMPT_TEMPLATE = `你不是被动回答问题的助手，而是一个【自主执行的任务型 agent】。
你的目标不是“给建议”，而是【把事情真正完成】。

【工作方式】
- 如果目标不完全明确，你必须先提出一个【可执行的任务拆解】，然后立即开始执行。
- 一旦目标确定，默认持续推进，不要等待逐步确认。
- 除非遇到明确歧义、权限或安全风险，否则不要中途停下询问。

【主动行动授权】
你被明确授权并鼓励：
- 主动搜索和调研外部信息
- 对比方案、验证假设、运行示例
- 补齐你认为缺失但对完成目标必要的信息
如果没有外部证据或验证，请假设任务尚未完成。

【任务状态（必须持续维护）】
在整个任务过程中，你必须维护并更新以下状态：

Goal:
- 最终目标（一句话）

Task Tree:
- [ ] 子任务（todo / doing / done）

Progress Log:
- 已完成的关键步骤与结论

Open Questions:
- 当前不确定但不阻塞推进的问题

Next Actions:
- 下一步你将立即执行的动作

【输出规则（每一轮都遵守）】
- 简要说明你刚完成了什么
- 更新 Task Tree 状态
- 给出关键发现（如有）
- 明确写出你接下来将执行的 Next Actions
不要只停留在总结或建议层。

【默认假设】
- 用户很忙，不想盯着每一步
- 默认“继续推进”，除非用户明确说停
- 如果任务还没达到可交付结果，你就不能结束

现在开始，以任务型 agent 的身份推进用户给出的任何目标。`;

function asReasoningEffort(v: unknown): ReasoningEffort | '' {
  if (typeof v !== 'string') return '';
  const t = v.trim() as ReasoningEffort;
  return REASONING_VALUES.includes(t) ? t : '';
}

function normalizeStreamText(v: string): string {
  return v.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function formatTs(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'n/a';
  return new Date(ts).toLocaleString();
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function findNestedRecord(root: unknown, key: string): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown): Record<string, unknown> | null => {
    const rec = toRecord(node);
    if (!rec || seen.has(rec)) return null;
    seen.add(rec);
    const target = toRecord(rec[key]);
    if (target) return target;
    for (const value of Object.values(rec)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function formatResetAt(v: unknown): string {
  const raw = toNumber(v);
  if (raw === null) return 'n/a';
  const tsMs = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  return formatTs(tsMs);
}

function formatStatusSummary(status: CliStatus, chatId: string, fallbackRuntimeStatus: string): string {
  const runtimeItem = status.chats?.items?.find((item) => item.id === chatId);
  const runtimeStatus = runtimeItem?.status || fallbackRuntimeStatus || 'idle';
  const sessionId = status.session?.id ? status.session.id.slice(0, 8) : 'n/a';
  const activeChatId = status.session?.activeChatId || 'none';
  const defaults = status.defaults;
  const lines: string[] = [
    `status: session=${sessionId} active=${activeChatId} now=${formatTs(status.time)}`,
    `runtime: chat=${chatId.slice(0, 6)} status=${runtimeStatus} running=${status.chats?.running ?? 0}/${status.chats?.total ?? 0}`,
    `defaults: model=${defaults?.model || 'default'} effort=${defaults?.reasoningEffort || 'default'} cwd=${defaults?.cwd || '(default)'}`,
    `session: created=${formatTs(status.session?.createdAt)} expires=${formatTs(status.session?.expiresAt)}`
  ];

  const cliUsage = toRecord(status.cliUsage);
  const context = cliUsage ? toRecord(cliUsage.context_window) : null;
  const ctxTotal = toNumber(context?.total_tokens);
  const ctxUsed = toNumber(context?.used_tokens);
  if (ctxTotal !== null && ctxUsed !== null && ctxTotal > 0) {
    const left = Math.max(0, ctxTotal - ctxUsed);
    const leftPct = Math.max(0, Math.min(100, Math.round((left / ctxTotal) * 100)));
    lines.push(`context: ${leftPct}% left (${formatTokens(ctxUsed)} used / ${formatTokens(ctxTotal)})`);
  }

  const primary = findNestedRecord(status.cliRateLimits, 'primary');
  const secondary = findNestedRecord(status.cliRateLimits, 'secondary');
  const primaryUsed = toNumber(primary?.used_percent);
  const secondaryUsed = toNumber(secondary?.used_percent);
  if (primaryUsed !== null) {
    const left = Math.max(0, 100 - Math.round(primaryUsed));
    lines.push(`5h limit: ${left}% left (resets ${formatResetAt(primary?.resets_at)})`);
  }
  if (secondaryUsed !== null) {
    const left = Math.max(0, 100 - Math.round(secondaryUsed));
    lines.push(`weekly limit: ${left}% left (resets ${formatResetAt(secondary?.resets_at)})`);
  }

  return lines.join('\n');
}

function queuedPromptsStorageKey(sid: string, chatId: string) {
  return `${QUEUED_PROMPTS_KEY_PREFIX}${sid}:${chatId}`;
}

function loadQueuedPrompts(sid: string, chatId: string): string[] {
  if (!sid || !chatId) return [];
  try {
    const raw = window.localStorage.getItem(queuedPromptsStorageKey(sid, chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter((item): item is string => item.length > 0);
  } catch {
    return [];
  }
}

function saveQueuedPrompts(sid: string, chatId: string, prompts: string[]) {
  if (!sid || !chatId) return;
  try {
    if (!prompts.length) {
      window.localStorage.removeItem(queuedPromptsStorageKey(sid, chatId));
      return;
    }
    window.localStorage.setItem(queuedPromptsStorageKey(sid, chatId), JSON.stringify(prompts.slice(0, 200)));
  } catch {
    // ignore localStorage failures
  }
}

function currentInstanceOrigin(): string {
  try {
    return window.location.origin || '';
  } catch {
    return '';
  }
}

const MessageRow = memo(
  function MessageRow(props: { message: ChatMessage }) {
    const m = props.message;
    return (
      <div className={`msg ${m.role}`}>
        <div className="role">{m.role}</div>
        <pre className="bubble">{normalizeStreamText(m.text)}</pre>
      </div>
    );
  },
  (prev, next) => prev.message === next.message
);

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
  const [otp, setOtp] = useState('');
  const [status, setStatus] = useState<string>('');
  const [statusKind, setStatusKind] = useState<'info' | 'error' | 'success'>('info');
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [totpProvisioned, setTotpProvisioned] = useState(false);
  const [busy, setBusy] = useState(false);

  const hintId = 'login-hint';

  const setStatusMsg = (kind: typeof statusKind, msg: string) => {
    setStatusKind(kind);
    setStatus(msg);
  };

  const refreshTotpQr = async () => {
    if (busy) return;
    setBusy(true);
    setStatusMsg('info', 'Loading QR...');
    try {
      const statusResp = await getTotpStatus().catch(() => ({ ok: false } as const));
      if (!statusResp.ok) {
        setStatusMsg('error', 'Failed to load TOTP status.');
        return;
      }
      if (!statusResp.enabled) {
        setTotpQr(null);
        setStatusMsg('error', 'TOTP is not configured on server.');
        return;
      }
      const provisioned = Boolean(statusResp.provisioned);
      setTotpProvisioned(provisioned);
      if (provisioned) {
        setTotpQr(null);
        setStatusMsg('info', '');
        return;
      }

      const uriResp = await getTotpUri().catch(() => ({ ok: false } as const));
      if (!uriResp.ok || !uriResp.uri) {
        setTotpQr(null);
        setStatusMsg('error', 'QR not available.');
        return;
      }

      const dataUrl = await QRCode.toDataURL(uriResp.uri, { margin: 1, width: 240 });
      setTotpQr(dataUrl);
      setStatusMsg('info', '');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshTotpQr();
  }, []);

  const verifyEnabled = otp.length === 6 && !busy;

  const doVerify = async () => {
    if (!verifyEnabled) return;
    setBusy(true);
    setStatusMsg('info', 'Verifying...');
    try {
      const r = await totpVerify(otp);
      if (r.ok) {
        setTotpProvisioned(true);
        setTotpQr(null);
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

  return (
    <div className="page">
      <div className="card">
        <div className="title">Codex Web Chat</div>
        <div className="subtitle">TOTP login (scan once in an authenticator app)</div>

        {!totpProvisioned ? (
          <div className="setup">
            <div className="subtitle">First login: scan this QR with your authenticator app.</div>
            {totpQr ? (
              <div className="qr">
                <img src={totpQr} width={240} height={240} alt="TOTP QR" />
              </div>
            ) : (
              <div className="status">QR is not available right now.</div>
            )}
            <div className="row">
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  await refreshTotpQr();
                }}
                disabled={busy}
              >
                {busy ? 'Working...' : 'Reload QR'}
              </button>
            </div>
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
          {totpProvisioned
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Scan the QR first, then enter the 6-digit code from your authenticator app.'}
        </div>
        {status ? <div className={`status ${statusKind === 'error' ? 'status-error' : statusKind === 'success' ? 'status-success' : ''}`}>{status}</div> : null}
      </div>
    </div>
  );
}

function Chat(props: { chatId: string; sessionId: string; onSwitchChat: (chatId: string) => void | Promise<void>; onLogout: () => void | Promise<void> }) {
  const INITIAL_RENDER_COUNT = 15;
  const LOAD_MORE_COUNT = 15;
  const INITIAL_SESSION_RENDER_COUNT = 120;
  const SESSION_RENDER_STEP = 120;

  type ActivityItem = {
    ts: number;
    stage: string;
    message: string;
    source: 'progress' | 'codex_event';
  };

  const [chatList, setChatList] = useState<{ id: string; updatedAt: number; createdAt: number; preview?: string }[]>([]);
  const [terminalList, setTerminalList] = useState<TerminalSession[]>([]);
  const [chatListBusy, setChatListBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
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
  const [fullscreenMode, setFullscreenMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      if (window.matchMedia('(max-width: 760px)').matches) return true;
      const raw = window.localStorage.getItem(FULLSCREEN_DESKTOP_KEY);
      if (raw === '1') return true;
      if (raw === '0') return false;
      return false;
    } catch {
      return false;
    }
  });
  const [fullscreenComposerOpen, setFullscreenComposerOpen] = useState(false);
  const [fullscreenComposerText, setFullscreenComposerText] = useState('');
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [cwdRoots, setCwdRoots] = useState<{ path: string; label: string }[]>([]);
  const [cwdPath, setCwdPath] = useState<string>('');
  const [cwdEntries, setCwdEntries] = useState<{ name: string; type: string }[]>([]);
  const [cwdNewDirName, setCwdNewDirName] = useState('');
  const [cwdPickerErr, setCwdPickerErr] = useState<string>('');
  const [lastUpdateAt, setLastUpdateAt] = useState<number>(0);
  const [runtimeStatus, setRuntimeStatus] = useState<string>('');
  const [runtimeLastEventId, setRuntimeLastEventId] = useState<number>(0);
  const [lastSseEventAt, setLastSseEventAt] = useState<number>(0);
  const [lastSseEventId, setLastSseEventId] = useState<number>(0);
  const [lastSseEventName, setLastSseEventName] = useState<string>('');
  const [lastDeltaAt, setLastDeltaAt] = useState<number>(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityOpen, setActivityOpen] = useState<boolean>(true);
  const [pollOkAt, setPollOkAt] = useState<number>(0);
  const [pollErrorCount, setPollErrorCount] = useState<number>(0);
  const [pollErrorAt, setPollErrorAt] = useState<number>(0);
  const [streamErrorCount, setStreamErrorCount] = useState<number>(0);
  const [streamErrorAt, setStreamErrorAt] = useState<number>(0);
  const [uiNow, setUiNow] = useState<number>(0);
  const [streamStatus, setStreamStatus] = useState<'connected' | 'reconnecting'>('connected');
  const [sessionRenderCount, setSessionRenderCount] = useState(INITIAL_SESSION_RENDER_COUNT);
  type QueueState = { sid: string; chatId: string; prompts: string[] };
  const [queueState, setQueueState] = useState<QueueState>(() => ({
    sid: props.sessionId,
    chatId: props.chatId,
    prompts: loadQueuedPrompts(props.sessionId, props.chatId)
  }));
  // Keep the rest of the component using the old `queuedPrompts` / `setQueuedPrompts` shape.
  const queuedPrompts =
    queueState.sid === props.sessionId && queueState.chatId === props.chatId ? queueState.prompts : [];
  const setQueuedPrompts = (next: string[] | ((prev: string[]) => string[])) => {
    setQueueState((prev) => {
      const prompts = typeof next === 'function' ? (next as (p: string[]) => string[])(prev.prompts) : next;
      return { ...prev, prompts };
    });
  };
  const [mobileChatListOpen, setMobileChatListOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);

  const chatRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number>(0);
  const resumeRebuildRef = useRef<boolean>(false);
  const pollTimerRef = useRef<number | null>(null);
  const startTurnRef = useRef<boolean>(false);
  const busyRef = useRef<boolean>(false);
  const terminalListRefreshSeqRef = useRef(0);
  const historyLoadRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const historyLoadingRef = useRef(false);

  const pushActivity = (item: Omit<ActivityItem, 'ts'> & { ts?: number }) => {
    const ts = typeof item.ts === 'number' ? item.ts : nowTs();
    const stage = String(item.stage || 'progress');
    const message = String(item.message || '').slice(0, 220);
    setActivity((prev) => {
      const next = [...prev, { ts, stage, message, source: item.source }];
      const max = 80;
      return next.length > max ? next.slice(next.length - max) : next;
    });
  };

  const summarizeCodexEvent = (msg: any): { stage: string; message: string } | null => {
    if (!msg) return null;
    const t = typeof msg.type === 'string' ? msg.type : '';
    const message =
      (typeof msg.message === 'string' && msg.message) ||
      (typeof msg.status === 'string' && msg.status) ||
      '';

    const cmdArr = Array.isArray(msg.command) ? msg.command.map(String) : null;
    const cmdStr = cmdArr && cmdArr.length ? cmdArr.join(' ') : '';

    const interesting =
      Boolean(cmdStr) ||
      (t && /(tool|command|exec|run|shell|terminal|fs|file|patch|apply|read|write|open|search|error|warn)/i.test(t));

    if (!interesting) return null;

    const stage = t || (cmdStr ? 'command' : 'codex_event');
    const m = cmdStr || message || (t ? `event=${t}` : 'codex_event');
    return { stage, message: m.slice(0, 220) };
  };

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

  useEffect(() => {
    setSessionRenderCount((prev) => {
      if (chatList.length <= 0) return INITIAL_SESSION_RENDER_COUNT;
      return Math.min(chatList.length, Math.max(prev, INITIAL_SESSION_RENDER_COUNT));
    });
  }, [chatList.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isMobileLayout) {
      setFullscreenMode(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(FULLSCREEN_DESKTOP_KEY);
      setFullscreenMode(raw === '1');
    } catch {
      setFullscreenMode(false);
    }
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
      setMobileChatListOpen(false);
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
    setMobileChatListOpen(false);
    addSystem(`Open terminal: ${terminal.terminalId} (cwd=${terminal.cwd || 'default'})`);
  };

  const selectChat = (chatId: string) => {
    setActiveTerminal(null);
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
        if (rt2?.ok && typeof rt2.status === 'string') setRuntimeStatus(rt2.status);
        if (rt2?.ok && typeof rt2.lastEventId === 'number') setRuntimeLastEventId(rt2.lastEventId);
        setPollOkAt(nowTs());
        if (rt2.ok && rt2.status !== 'running') {
          stopPolling();
          setBusy(false);
          closeStream();
          setStreamStatus('connected');
        }
      } catch {
        setPollErrorCount((c) => c + 1);
        setPollErrorAt(nowTs());
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

    const onAny = (ev: MessageEvent, eventName: string) => {
      const lid = Number((ev as any).lastEventId || '0');
      if (Number.isFinite(lid)) lastEventIdRef.current = lid;
      if (Number.isFinite(lid)) setLastSseEventId(lid);
      setLastSseEventAt(nowTs());
      setLastSseEventName(eventName);
    };

    es.addEventListener('start', (ev: any) => {
      onAny(ev, 'start');
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
      onAny(ev, 'delta');
      setLastDeltaAt(nowTs());
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

    es.addEventListener('progress', (ev: any) => {
      onAny(ev, 'progress');
      try {
        const data = JSON.parse(ev.data || '{}');
        const stage = typeof data.stage === 'string' ? data.stage : 'progress';
        const message = typeof data.message === 'string' ? data.message : JSON.stringify(data);
        pushActivity({ source: 'progress', stage, message });
      } catch {
        pushActivity({ source: 'progress', stage: 'progress', message: String(ev?.data || '') });
      }
    });

    es.addEventListener('codex_event', (ev: any) => {
      onAny(ev, 'codex_event');
      try {
        const data = JSON.parse(ev.data || 'null');
        const s = summarizeCodexEvent(data);
        if (s) pushActivity({ source: 'codex_event', stage: s.stage, message: s.message });
      } catch {}
    });

    es.addEventListener('approval_request', (ev: any) => {
      onAny(ev, 'approval_request');
      try {
        const data = JSON.parse(ev.data || '{}');
        setApproval(data);
      } catch {}
    });

    const finish = async (kind: 'done' | 'turn_error', ev: any) => {
      onAny(ev, kind);
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
        if (rt2?.ok && typeof rt2.status === 'string') setRuntimeStatus(rt2.status);
        if (rt2?.ok && typeof rt2.lastEventId === 'number') setRuntimeLastEventId(rt2.lastEventId);
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
      setStreamErrorCount((c) => c + 1);
      setStreamErrorAt(nowTs());
      if (busyRef.current) startPolling();
    });
  };

  const syncNow = async () => {
    try {
      setErr(null);
      setUiStatus('Syncing...');
      const [c2, rt2] = await Promise.all([getChat(props.chatId), getChatRuntime(props.chatId)]);
      setMessages(c2.messages);
      const { sandbox: _s, approvalPolicy: _a, ...savedSettings } = c2.settings || {};
      setSettings(savedSettings);
      if (rt2?.ok && typeof rt2.updatedAt === 'number') setLastUpdateAt(rt2.updatedAt);
      if (rt2?.ok && typeof rt2.status === 'string') setRuntimeStatus(rt2.status);
      if (rt2?.ok && typeof rt2.lastEventId === 'number') setRuntimeLastEventId(rt2.lastEventId);
      setPollOkAt(nowTs());
      void refreshChatList();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setUiStatus('');
    }
  };

  const reconnectNow = async () => {
    try {
      setErr(null);
      const rt = await getChatRuntime(props.chatId).catch(() => ({ ok: false } as any));
      if (rt?.ok && typeof rt.updatedAt === 'number') setLastUpdateAt(rt.updatedAt);
      if (rt?.ok && typeof rt.status === 'string') setRuntimeStatus(rt.status);
      const rtEid = rt?.ok && typeof rt.lastEventId === 'number' ? rt.lastEventId : 0;
      if (rtEid) setRuntimeLastEventId(rtEid);

      const after = Math.max(0, lastEventIdRef.current || 0, rtEid || 0, runtimeLastEventId || 0);
      lastEventIdRef.current = after;
      connectStream(after);

      if (rt?.ok && rt.status === 'running') {
        setBusy(true);
        startPolling();
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (busy) startPolling();
    else stopPolling();
  }, [busy]);

  useEffect(() => {
    if (!busy) {
      setUiNow(0);
      return;
    }
    setUiNow(Date.now());
    const t = window.setInterval(() => setUiNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    // Important: save to the queue's owner (sid/chatId) carried with the prompts state.
    // This prevents cross-chat "sync" when props.chatId changes but state hasn't been hydrated yet.
    saveQueuedPrompts(queueState.sid, queueState.chatId, queueState.prompts);
  }, [queueState.sid, queueState.chatId, queueState.prompts]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      setBusy(false);
      setApproval(null);
      setStreamStatus('connected');
      setQueueState({ sid: props.sessionId, chatId: props.chatId, prompts: loadQueuedPrompts(props.sessionId, props.chatId) });
      setRenderCount(INITIAL_RENDER_COUNT);
      setRuntimeStatus('');
      setRuntimeLastEventId(0);
      setLastUpdateAt(0);
      setLastSseEventAt(0);
      setLastSseEventId(0);
      setLastSseEventName('');
      setLastDeltaAt(0);
      setActivity([]);
      setActivityOpen(true);
      setPollOkAt(0);
      setPollErrorCount(0);
      setPollErrorAt(0);
      setStreamErrorCount(0);
      setStreamErrorAt(0);
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
      if (rt?.ok && typeof rt.status === 'string') setRuntimeStatus(rt.status);
      if (rt?.ok && typeof rt.lastEventId === 'number') setRuntimeLastEventId(rt.lastEventId);
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

  const renderStart = Math.max(0, messages.length - renderCount);
  const visibleMessages = messages.slice(renderStart);
  const nowForUi = uiNow || Date.now();

  const onChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;

    // Near-top threshold to trigger history expansion.
    if (el.scrollTop > 80) return;
    if (renderStart <= 0) return;
    if (historyLoadingRef.current) return;

    historyLoadingRef.current = true;
    historyLoadRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
    setRenderCount((c) => Math.min(messages.length, c + LOAD_MORE_COUNT));
  };

  useLayoutEffect(() => {
    const el = chatRef.current;
    const pending = historyLoadRef.current;
    if (!el || !pending) return;

    const delta = el.scrollHeight - pending.prevScrollHeight;
    el.scrollTop = pending.prevScrollTop + delta;

    historyLoadRef.current = null;
    historyLoadingRef.current = false;
  }, [renderCount]);

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
    if (typeof window === 'undefined') return;
    if (isMobileLayout) return;
    window.localStorage.setItem(FULLSCREEN_DESKTOP_KEY, fullscreenMode ? '1' : '0');
  }, [fullscreenMode, isMobileLayout]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const applySettings = async (patch: any, local: Partial<typeof settings>, statusText?: string) => {
    if (patch && typeof patch === 'object') {
      if ('sandbox' in patch || 'approvalPolicy' in patch) {
        return false;
      }
    }
    try {
      setErr(null);
      setUiStatus(statusText || 'Updating...');
      await updateChatSettings(props.chatId, patch);
      setSettings((s) => ({ ...s, ...local }));
      return true;
    } catch (e: any) {
      setErr(String(e?.message || e));
      return false;
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
      const r = await sendMessageAsync(props.chatId, promptText, settings.model || undefined);
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
          if (rt.ok && typeof rt.status === 'string') setRuntimeStatus(rt.status);
          if (rt.ok && typeof rt.lastEventId === 'number') setRuntimeLastEventId(rt.lastEventId);
          if (rt.ok && rt.status !== 'running') setBusy(false);
        } catch {}
      }, 1500);
    } finally {
      startTurnRef.current = false;
    }
  };

  const sendPrompt = async (inputValue: string): Promise<boolean> => {
    const trimmed = inputValue.trim();
    if (!trimmed) return false;

    // Escape: `//foo` -> send `/foo` literally (bypasses local slash-commands).
    const escapedLeadingSlash = trimmed.startsWith('//');
    const rawPromptText = escapedLeadingSlash ? trimmed.slice(1) : trimmed;
    const isSlashCommand = rawPromptText.startsWith('/') && !escapedLeadingSlash;
    if (isSlashCommand) {
      const [cmdRaw, ...argParts] = rawPromptText.slice(1).trim().split(/\s+/);
      const cmd = (cmdRaw || '').toLowerCase();
      const args = argParts.join(' ').trim();
      const argsLower = args.toLowerCase();
      const isWebModelCommand = cmd === 'web' && /^model(\s|$)/i.test(args);
      if (cmd === 'status' || (cmd === 'web' && argsLower === 'status')) {
        try {
          const r = await getStatus();
          if (!r.ok || !r.status) {
            addSystem(`Status failed: ${r.error || 'unknown_error'}`);
            setText('');
            return true;
          }
          addSystem(formatStatusSummary(r.status, props.chatId, runtimeStatus || (busy ? 'running' : 'idle')));
        } catch (e: any) {
          addSystem(`Status failed: ${String(e?.message || e)}`);
        }
        setText('');
        return true;
      }
      if (cmd === 'model' || isWebModelCommand) {
        const modelArgRaw = (cmd === 'model' ? args : args.replace(/^model(\s+|$)/i, '')).trim();
        const effectiveModel = settings.model || defaults?.model || 'default';
        if (!modelArgRaw) {
          const options = modelOptions.map((m) => m.slug).join(', ') || '(none)';
          addSystem(`model=${effectiveModel}\nusage: /model <id|default>\noptions: ${options}`);
          setText('');
          return true;
        }
        if (busy || startTurnRef.current) {
          addSystem('Cannot change model while a turn is running.');
          setText('');
          return true;
        }
        if (modelArgRaw.toLowerCase() === 'default') {
          setModelInput('');
          const ok = await applySettings({ model: null }, { model: undefined }, 'Model -> default');
          addSystem(ok ? `Model -> default (${defaults?.model || 'auto'})` : 'Model change failed.');
          setText('');
          return true;
        }

        setModelInput(modelArgRaw);
        const ok = await applySettings({ model: modelArgRaw }, { model: modelArgRaw }, `Model -> ${modelArgRaw}`);
        if (!ok) {
          addSystem('Model change failed.');
        } else {
          const isKnown = modelOptions.some((m) => m.slug === modelArgRaw);
          addSystem(isKnown ? `Model -> ${modelArgRaw}` : `Model -> ${modelArgRaw} (custom)`);
        }
        setText('');
        return true;
      }
      if (cmd === 'resume') {
        const status = await getStatus();
        if (!status.ok || !status.status?.session?.activeChatId) {
          addSystem('No resumable active chat found.');
          setText('');
          return true;
        }
        const target = status.status.session.activeChatId;
        if (target) {
          selectChat(target);
          addSystem(`Resumed chat: ${target}`);
        } else {
          addSystem('No resumable active chat found.');
        }
        setText('');
        return true;
      }
      if (cmd === 'web' && argsLower === 'help') {
        addSystem('Web commands: /status, /model [id|default], /resume, /compact [keep_last], /web help');
        setText('');
        return true;
      }
      if (cmd === 'compact') {
        if (busy || startTurnRef.current) {
          addSystem('Cannot compact while a turn is running.');
          setText('');
          return true;
        }

        const rawKeep = args.trim();
        const parsedKeep = rawKeep ? Number(rawKeep) : null;
        if (rawKeep && (parsedKeep === null || !Number.isFinite(parsedKeep) || parsedKeep < 0)) {
          addSystem('Usage: /compact [keep_last]');
          setText('');
          return true;
        }
        try {
          const r = await compactChat(props.chatId, parsedKeep ?? undefined);
          if (!r.ok) {
            setErr(r.error || 'compact_failed');
            return true;
          }
          await syncNow();
          addSystem(`OK: compact complete (removed ${r.removedCount || 0} messages).`);
        } catch (e: any) {
          setErr(String(e?.message || e));
        } finally {
          setText('');
          return true;
        }
      }
    }

    const promptText = rawPromptText;
    setText('');

    if (busy || startTurnRef.current) {
      setQueuedPrompts((q) => [...q, promptText]);
      return true;
    }

    await startTurn(promptText, { restoreText: trimmed });
    return true;
  };

  const send = async () => {
    await sendPrompt(text);
  };

  const openFullscreenComposer = () => {
    setFullscreenComposerText(text);
    setFullscreenComposerOpen(true);
  };

  const closeFullscreenComposer = () => {
    setFullscreenComposerOpen(false);
  };

  const sendFullscreenComposer = async () => {
    const accepted = await sendPrompt(fullscreenComposerText);
    if (!accepted) return;
    setFullscreenComposerText('');
    setFullscreenComposerOpen(false);
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
  const isTerminalView = Boolean(activeTerminal);
  const activeChatIndex = chatList.findIndex((chat) => chat.id === props.chatId);
  const visibleSessionLimit = activeChatIndex >= 0 ? Math.max(sessionRenderCount, activeChatIndex + 1) : sessionRenderCount;
  const visibleChatList = chatList.slice(0, Math.max(INITIAL_SESSION_RENDER_COUNT, visibleSessionLimit));
  const instanceValue = INSTANCE_OPTIONS.some((o) => o.origin === currentInstanceOrigin())
    ? currentInstanceOrigin()
    : '';
  const switchInstance = (nextOrigin: string) => {
    const opt = INSTANCE_OPTIONS.find((o) => o.origin === nextOrigin);
    if (!opt) return;
    const target = `${opt.origin}${opt.path}`;
    if (target === `${window.location.origin}${window.location.pathname.replace(/\/+$/, '')}`) return;

    const dirty =
      Boolean(busy) ||
      (queueState.sid === props.sessionId && queueState.chatId === props.chatId && queueState.prompts.length > 0) ||
      (!isTerminalView && text.trim().length > 0);
    if (dirty) {
      const ok = window.confirm('切换实例会中断当前运行/丢失未发送内容，确定切换吗？');
      if (!ok) return;
    }
    window.location.assign(target);
  };

  const modelOptions = defaults?.modelOptions || [];
  const effectiveModel = settings.model || defaults?.model || '';
  const effectiveReasoningEffort = settings.reasoningEffort || defaults?.reasoningEffort || '';
  const effectiveCwd = settings.cwd || defaults?.cwd || '';
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
    <div className={`page page-chat ${fullscreenMode ? 'fullscreen-mode' : ''}`}>
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
            {visibleChatList.length > 0 ? visibleChatList.map((chat) => (
              <div key={chat.id} className="session-tab-row">
                <button
                  className={`session-tab ${chat.id === props.chatId && !isTerminalView ? 'active' : ''}`}
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
            {chatList.length > visibleChatList.length ? (
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                disabled={chatListBusy}
                onClick={() => setSessionRenderCount((c) => Math.min(chatList.length, c + SESSION_RENDER_STEP))}
              >
                Load More Sessions ({chatList.length - visibleChatList.length})
              </button>
            ) : null}
            {terminalList.length > 0 ? (
              <>
                <div className="session-tab session-tab-empty" style={{ margin: '6px 0 2px' }}>
                  Terminal sessions
                </div>
                {terminalList.map((terminal) => (
                  <div key={terminal.terminalId} className="session-tab-row">
                    <button
                      className={`session-tab ${terminal.terminalId === activeTerminal?.terminalId && isTerminalView ? 'active' : ''}`}
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
            {null}
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

        <section className={`chat-main ${isTerminalView ? 'chat-main-terminal' : ''}`}>
          <div className="topbar">
            {isMobileLayout ? (
              <button className="btn btn-secondary btn-sm mobile-chat-btn" onClick={openChatListMobile}>
                聊天
              </button>
            ) : null}
            <div className="title">{isTerminalView ? 'Terminal' : 'Codex'}</div>
            <div className="topmeta">
              <span className="badge badge-tight">
                {isTerminalView ? activeTerminal?.terminalId.slice(0, 6) : props.chatId.slice(0, 6)}
              </span>
              {isTerminalView ? (
                <span className="badge badge-tight">{activeTerminal?.status || 'running'}</span>
              ) : busy ? (
                <span className="badge badge-tight badge-running">Running</span>
              ) : (
                <span className="badge badge-tight">Idle</span>
              )}
            </div>
            {!isTerminalView ? (
              <div className="badge">
                {effectiveModel ? `model=${effectiveModel}` : 'model=default'}{' '}
                {effectiveReasoningEffort ? `effort=${effectiveReasoningEffort}` : ''}{' '}
                {`sandbox=${defaults?.sandbox || LOCKED_SANDBOX}`}{' '}
                {`approval=${defaults?.approvalPolicy || LOCKED_APPROVAL_POLICY}`}{' '}
                {effectiveCwd ? `cwd=${effectiveCwd}` : ''}
              </div>
            ) : null}
            <div className="spacer" />
            <select
              className="input input-sm"
              style={{ flex: '0 0 auto', minWidth: 160 }}
              value={instanceValue}
              onChange={(e) => switchInstance(e.target.value)}
              title="Switch instance"
            >
              <option value="" disabled>
                Instance
              </option>
              {INSTANCE_OPTIONS.map((o) => (
                <option key={o.origin} value={o.origin}>
                  {o.label}
                </option>
              ))}
            </select>
            {!isTerminalView ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setControlsOpen((v) => !v)}>
                Settings
              </button>
            ) : null}
            {!isTerminalView ? (
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
            ) : null}
            <button className="btn btn-secondary" onClick={() => props.onLogout()}>
              Logout
            </button>
          </div>
          {!isTerminalView ? (
            <>
        <div className={`controls ${controlsOpen ? 'open' : 'closed'}`}>
          <div className="controls-head">
            <div className="ctl-label">Settings</div>
            <button className="btn btn-secondary btn-sm" onClick={() => setControlsOpen(false)}>
              Back to Chat
            </button>
          </div>
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
                  void applySettings({ model: null }, { model: undefined }, 'Model -> default');
                  return;
                }
                if (v === MODEL_CUSTOM_VALUE) {
                  if (!modelInputTrimmed) setModelInput(settings.model || '');
                  return;
                }
                setModelInput(v);
                void applySettings({ model: v }, { model: v }, `Model -> ${v}`);
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
            <div className="ctl-label">Diagnostics</div>
            <div className="badge badge-tight">{`rt=${runtimeStatus || (busy ? 'running' : 'idle')}`}</div>
            <div className="badge badge-tight">{`rt_eid=${runtimeLastEventId || 0}`}</div>
            <div className="badge badge-tight">{`stream=${streamStatus}`}</div>
            <div className="badge badge-tight">{`es=${esRef.current ? esRef.current.readyState : 'n/a'}`}</div>
            <div className="badge badge-tight">
              {`sse=${lastSseEventName || 'none'}/${lastSseEventId || 0} ${lastSseEventAt ? Math.max(0, Math.round((nowForUi - lastSseEventAt) / 1000)) : '?'}s ago`}
            </div>
            <div className="badge badge-tight">
              {`poll_ok=${pollOkAt ? Math.max(0, Math.round((nowForUi - pollOkAt) / 1000)) : '?'}s poll_err=${pollErrorCount}`}
            </div>
            <div className="badge badge-tight">
              {`poll_err_ago=${pollErrorAt ? Math.max(0, Math.round((nowForUi - pollErrorAt) / 1000)) : '?'}s`}
            </div>
            <div className="badge badge-tight">
              {`stream_err=${streamErrorCount} err_ago=${streamErrorAt ? Math.max(0, Math.round((nowForUi - streamErrorAt) / 1000)) : '?'}s`}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => void syncNow()}>
              Sync
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => void reconnectNow()}>
              Reconnect
            </button>
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
              disabled={busy}
              onClick={async () => {
                try {
                  const r = await compactChat(props.chatId);
                  if (!r.ok) {
                    setErr(r.error || 'compact_failed');
                    return;
                  }
                  await syncNow();
                  addSystem(`OK: compact complete (removed ${r.removedCount || 0} messages).`);
                } catch (e: any) {
                  setErr(String(e?.message || e));
                }
              }}
            >
              Compact
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

        <div className="chat" ref={chatRef} onScroll={onChatScroll}>
          {visibleMessages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          {fullscreenMode && isMobileLayout ? (
            <button className="composer-input-trigger" type="button" onClick={openFullscreenComposer}>
              {text.trim() ? normalizeStreamText(text) : 'Tap to type your message'}
            </button>
          ) : (
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
          )}
          <div className="composer-actions">
            {fullscreenMode && isMobileLayout ? (
              <button className="btn btn-secondary" onClick={openChatListMobile}>
                Session
              </button>
            ) : null}
            <button className="btn btn-secondary" onClick={() => setFullscreenMode((v) => !v)}>
              {fullscreenMode ? 'Normal' : 'Full'}
            </button>
            <button className="btn" onClick={() => setText(AGENT_PROMPT_TEMPLATE)}>
              prompt
            </button>
            <button className="btn" disabled={text.trim().length === 0} onClick={() => void send()}>
              {busy ? 'Queue' : 'Send'}
            </button>
          </div>
        </div>
        {fullscreenMode && isMobileLayout && fullscreenComposerOpen ? (
          <div className="overlay fullscreen-input-overlay" onClick={closeFullscreenComposer}>
            <div className="modal fullscreen-input-modal" onClick={(e) => e.stopPropagation()}>
              <div className="cwdpicker-head">
                <div className="cwdpicker-title">Message</div>
                <button className="btn btn-secondary btn-sm" onClick={closeFullscreenComposer}>
                  Close
                </button>
              </div>
              <textarea
                className="textarea fullscreen-input-textarea"
                placeholder="Ask Codex..."
                autoFocus
                value={fullscreenComposerText}
                onChange={(e) => setFullscreenComposerText(e.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(e) => {
                  const inComposition = composing || e.nativeEvent.isComposing || e.key === 'Process';
                  if (inComposition) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendFullscreenComposer();
                  }
                }}
              />
              <div className="row row-tight">
                <button className="btn btn-secondary" onClick={() => setFullscreenComposerText(AGENT_PROMPT_TEMPLATE)}>
                  prompt
                </button>
                <button
                  className="btn"
                  disabled={fullscreenComposerText.trim().length === 0}
                  onClick={() => void sendFullscreenComposer()}
                >
                  {busy ? 'Queue' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <div className="footnote">
          Enter to send, Shift+Enter for newline.
          {queuedPrompts.length > 0 ? <span className="muted"> (queued={queuedPrompts.length})</span> : null}
          {uiStatus ? <span className="muted"> ({uiStatus})</span> : null}
          {busy ? (
            <span className="muted">
              {' '}
              (running, rt={runtimeStatus || 'running'}, eid={runtimeLastEventId || 0}, stream={streamStatus}, last update{' '}
              {lastUpdateAt ? Math.max(0, Math.round((nowForUi - lastUpdateAt) / 1000)) : '?'}s, last SSE{' '}
              {lastSseEventAt ? Math.max(0, Math.round((nowForUi - lastSseEventAt) / 1000)) : '?'}s, last delta{' '}
              {lastDeltaAt ? Math.max(0, Math.round((nowForUi - lastDeltaAt) / 1000)) : '?'}s, poll_err=
              {pollErrorCount}, stream_err={streamErrorCount})
            </span>
          ) : null}
        </div>
        {busy && activity.length > 0 ? (
          <div className="activity">
            <div className="activity-head">
              <div className="activity-title">Activity</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setActivityOpen((v) => !v)}>
                {activityOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            {activityOpen ? (
              <div className="activity-body">
                {activity.slice(-10).map((a, idx) => (
                  <div className="activity-item" key={`act-${a.ts}-${idx}-${a.stage}`}>
                    <span className="activity-ago">{Math.max(0, Math.round((nowForUi - a.ts) / 1000))}s</span>
                    <span className="activity-stage">{a.stage}</span>
                    <span className="activity-msg">{a.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
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
            </>
          ) : activeTerminal ? (
            <TerminalPanel
              terminal={activeTerminal}
              onClose={() => setActiveTerminal(null)}
              onCopyId={(terminalId) => copyCredentialToClipboard(terminalId)}
            />
          ) : null}
      </section>
    </div>
    </div>
  );
}
