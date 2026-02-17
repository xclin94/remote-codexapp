export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
};

export type TerminalSession = {
  terminalId: string;
  cwd: string;
  createdAt: number;
  status?: 'running' | 'stopped';
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ModelOption = {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
};

export type Defaults = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  cwd: string;
  sandbox: string;
  approvalPolicy: string;
  modelOptions: ModelOption[];
  reasoningEffortOptions: ReasoningEffort[];
};

export type CredentialRecord = {
  id: string;
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
  usedCount?: number;
};

export type Chat = {
  id: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messages: ChatMessage[];
  messagesStart?: number;
  messagesTotal?: number;
  settings?: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    cwd?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  };
};

export type CliStatus = {
  time: number;
  usage?: Record<string, unknown>;
  cliUsage?: Record<string, unknown>;
  cliRateLimits?: Record<string, unknown>;
  cliUsageError?: string;
  defaults?: {
    model: string | null;
    reasoningEffort: string | null;
    cwd: string;
    sandbox: string;
    approvalPolicy: string;
  };
  session: {
    id: string;
    createdAt: number;
    expiresAt: number;
    activeChatId: string | null;
  };
  chats: {
    total: number;
    running: number;
    items: { id: string; status: string; updatedAt: number; usage?: Record<string, unknown> }[];
  };
};

export type ChatSettingsPatch = {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  cwd?: string | null;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
};

const API_PREFIX = (() => {
  if (typeof window === 'undefined') return '';
  const firstSeg = window.location.pathname.split('/').filter(Boolean)[0] || '';
  return firstSeg === 'codex' ? '/codex' : '';
})();

export function apiUrl(path: string): string {
  return `${API_PREFIX}${path}`;
}

export function terminalWsUrl(terminalId: string): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = apiUrl('/ws/terminal');
  return `${protocol}//${window.location.host}${path}?terminalId=${encodeURIComponent(terminalId)}`;
}

export async function apiMe(): Promise<{ ok: boolean; sessionId?: string; activeChatId?: string; expiresInMs?: number }> {
  const r = await fetch(apiUrl('/api/me'), { credentials: 'include' });
  if (!r.ok) return { ok: false };
  return await r.json();
}

export async function getTotpStatus(): Promise<{ ok: boolean; enabled?: boolean; provisioned?: boolean }> {
  const r = await fetch(apiUrl('/api/auth/totp/status'), { credentials: 'include' });
  if (!r.ok) return { ok: false };
  return await r.json();
}

export async function getTotpUri(): Promise<{ ok: boolean; uri?: string }> {
  const r = await fetch(apiUrl('/api/auth/totp/uri'), { credentials: 'include' });
  if (!r.ok) return { ok: false };
  return await r.json();
}

export async function totpVerify(code: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(apiUrl('/api/auth/totp/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code })
  });
  return await r.json();
}

export async function credentialLogin(credential: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  void credential;
  return { ok: false, error: 'disabled' };
}

export async function createCredential(label?: string): Promise<{
  ok: boolean;
  credential?: string;
  credentialId?: string;
  label?: string;
  error?: string;
}> {
  void label;
  return { ok: false, error: 'disabled' };
}

export async function listCredentials(): Promise<CredentialRecord[]> {
  return [];
}

export async function revokeCredential(credentialId: string): Promise<void> {
  void credentialId;
  throw new Error('disabled');
}

export async function logout(): Promise<void> {
  await fetch(apiUrl('/api/auth/logout'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
}

export async function createChat(): Promise<string> {
  const r = await fetch(apiUrl('/api/chats'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'failed');
  return j.chatId as string;
}

export async function createTerminal(cwd?: string): Promise<{ ok: boolean; terminal?: TerminalSession; error?: string }> {
  const body = JSON.stringify(cwd ? { cwd } : {});
  const doCreate = async (url: string) => {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body
    });
  };

  const looksLikeJson = (res: Response) => (res.headers.get('content-type') || '').toLowerCase().includes('application/json');
  let r = await doCreate(apiUrl('/api/terminal'));
  if (!looksLikeJson(r) && API_PREFIX) {
    const fallback = await doCreate('/api/terminal');
    if (looksLikeJson(fallback)) r = fallback;
  }
  if (!r.ok && r.status === 404 && API_PREFIX) {
    r = await doCreate('/api/terminal');
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  if (!j.ok) return { ok: false, error: j.error || 'failed' };
  return j as { ok: boolean; terminal?: TerminalSession; error?: string };
}

export async function listTerminals(): Promise<TerminalSession[]> {
  let r = await fetch(apiUrl('/api/terminals'), { credentials: 'include' });
  const looksLikeJson = (res: Response) => (res.headers.get('content-type') || '').toLowerCase().includes('application/json');

  if (!looksLikeJson(r) && API_PREFIX) {
    const fallback = await fetch('/api/terminals', { credentials: 'include' });
    if (looksLikeJson(fallback)) r = fallback;
  }
  if (!r.ok && r.status === 404 && API_PREFIX) {
    r = await fetch('/api/terminals', { credentials: 'include' });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !Array.isArray(j.terminals)) throw new Error(j.error || 'failed');
  return j.terminals as TerminalSession[];
}

export async function deleteChat(chatId: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}`), {
    method: 'DELETE',
    credentials: 'include'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'delete_failed');
}

export async function listChats(): Promise<{ id: string; updatedAt: number; createdAt: number; preview?: string; title?: string }[]> {
  const r = await fetch(apiUrl('/api/chats'), {
    credentials: 'include'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !Array.isArray(j.chats)) throw new Error(j.error || 'failed');
  return j.chats as { id: string; updatedAt: number; createdAt: number; preview?: string; title?: string }[];
}

export async function setActiveChat(chatId: string): Promise<void> {
  const r = await fetch(apiUrl('/api/session/active-chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ chatId })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'failed');
}

export async function renameChat(chatId: string, title: string | null): Promise<{ ok: boolean; title?: string | null; error?: string }> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/rename`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ title })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  return j as { ok: boolean; title?: string | null; error?: string };
}

export async function getChat(chatId: string, opts?: { tail?: number }): Promise<Chat> {
  const q = new URLSearchParams();
  if (typeof opts?.tail === 'number' && Number.isFinite(opts.tail) && opts.tail > 0) {
    q.set('tail', String(Math.floor(opts.tail)));
  }
  const suffix = q.toString() ? `?${q.toString()}` : '';
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}${suffix}`), {
    credentials: 'include'
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'failed');
  return j.chat as Chat;
}

export async function getChatRuntime(chatId: string): Promise<{ ok: boolean; status?: string; lastEventId?: number; updatedAt?: number; error?: string }> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/runtime`), { credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  return j as any;
}

export async function getDefaults(): Promise<{ ok: boolean; defaults?: Defaults }> {
  const r = await fetch(apiUrl('/api/defaults'), { credentials: 'include' });
  if (!r.ok) return { ok: false };
  return await r.json();
}

export async function getStatus(): Promise<{ ok: boolean; status?: CliStatus; error?: string }> {
  const r = await fetch(`${apiUrl('/api/status')}?ts=${Date.now()}`, {
    credentials: 'include',
    cache: 'no-store'
  });
  if (!r.ok) return { ok: false, error: `http_${r.status}` };
  const j = await r.json().catch(() => ({}));
  if (!j || !j.ok) return { ok: false, error: j?.error || 'failed' };
  return { ok: true, status: j as CliStatus };
}

export async function fsRoots(): Promise<{ ok: boolean; roots?: { path: string; label: string }[]; error?: string }> {
  const r = await fetch(apiUrl('/api/fs/roots'), { credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  return j;
}

export async function fsMkdir(p: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const r = await fetch(apiUrl('/api/fs/mkdir'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path: p })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  return j;
}

export async function fsLs(p?: string): Promise<{ ok: boolean; path?: string; entries?: { name: string; type: string }[]; error?: string }> {
  const u = new URL(apiUrl('/api/fs/ls'), window.location.origin);
  if (p) u.searchParams.set('path', p);
  const r = await fetch(u.toString(), { credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || 'failed' };
  return j;
}

export async function sendMessageAsync(chatId: string, text: string, model?: string): Promise<{ ok: boolean; assistantMessageId?: string; error?: string }> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/send_async`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text, model: model || undefined })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || `http_${r.status}` };
  return j;
}

export async function compactChat(
  chatId: string,
  keepLast?: number
): Promise<{ ok: boolean; removedCount?: number; keptCount?: number; compacted?: boolean; error?: string }> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/compact`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      keep_last: typeof keepLast === 'number' && Number.isFinite(keepLast)
        ? Math.max(0, Math.floor(keepLast))
        : undefined
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error || `http_${r.status}` };
  return j;
}

export async function updateChatSettings(chatId: string, patch: ChatSettingsPatch): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/settings`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'settings_failed');
}

export async function resetChatSession(chatId: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/reset`), {
    method: 'POST',
    credentials: 'include'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'reset_failed');
}

export async function abortChat(chatId: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/abort`), {
    method: 'POST',
    credentials: 'include'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'abort_failed');
}

export async function approveTool(chatId: string, id: string, decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/approve`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id, decision })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'approve_failed');
}

// SSE stream helper for sending a message.
export async function sendMessageStream(opts: {
  chatId: string;
  text: string;
  model?: string;
  onDelta: (t: string) => void;
  onApprovalRequest?: (req: { id: string; message?: string; command?: string[]; cwd?: string }) => void;
  onCodexEvent?: (msg: any) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}): Promise<void> {
  const r = await fetch(apiUrl(`/api/chats/${encodeURIComponent(opts.chatId)}/send`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text: opts.text, model: opts.model || undefined })
  });

  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    opts.onError(`HTTP ${r.status}: ${t}`);
    return;
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const handleEvent = (event: string, data: any) => {
    if (event === 'delta') {
      opts.onDelta(String(data.text || ''));
    } else if (event === 'approval_request') {
      opts.onApprovalRequest?.(data);
    } else if (event === 'codex_event') {
      opts.onCodexEvent?.(data);
    } else if (event === 'error') {
      opts.onError(String(data.message || 'error'));
    } else if (event === 'done') {
      opts.onDone();
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = 'message';
      let dataStr = '';
      for (const line of chunk.split('\n')) {
        const l = line.trimEnd();
        if (l.startsWith('event:')) event = l.slice(6).trim();
        if (l.startsWith('data:')) dataStr += l.slice(5).trim();
      }
      if (dataStr) {
        try {
          handleEvent(event, JSON.parse(dataStr));
        } catch {
          // ignore
        }
      }
    }
  }

  opts.onDone();
}
