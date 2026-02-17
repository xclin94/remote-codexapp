import {
  CodexMcpClient,
  type CodexApprovalDecision,
  type CodexRunnerEvent,
  type CodexUsage,
  type CodexRateLimits
} from './codexMcpClient.js';

function isProgressMsg(msg: unknown): msg is { type: 'progress'; stage?: unknown; message?: unknown; detail?: unknown } {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'progress';
}

type RunnerState = {
  client: CodexMcpClient;
  busy: boolean;
  abort?: AbortController;
  sessionConfigKey?: string;
  instanceId: string;
  codexHome?: string;
};

function sessionConfigKey(config: {
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}): string {
  return JSON.stringify({
    cwd: config.cwd ?? null,
    sandbox: config.sandbox ?? null,
    approvalPolicy: config.approvalPolicy ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null
  });
}

type CodexInstanceBinding = {
  instanceId: string;
  codexHome?: string;
};

// One runner per (sessionId, chatId). This keeps Codex session continuity for that chat.
export class CodexManager {
  private runners = new Map<string, RunnerState>();

  private key(sessionId: string, chatId: string) {
    return `${sessionId}:${chatId}`;
  }

  get(sessionId: string, chatId: string, binding?: CodexInstanceBinding): RunnerState {
    const k = this.key(sessionId, chatId);
    let r = this.runners.get(k);
    const nextInstanceId = binding?.instanceId || 'default';
    const nextCodexHome = binding?.codexHome?.trim() || undefined;

    if (r && (r.instanceId !== nextInstanceId || r.codexHome !== nextCodexHome)) {
      if (r.busy) throw new Error('chat_busy');
      this.runners.delete(k);
      r = undefined;
    }

    if (!r) {
      const env: Record<string, string> = {};
      if (nextCodexHome) env.CODEX_HOME = nextCodexHome;
      r = {
        client: new CodexMcpClient({ env }),
        busy: false,
        instanceId: nextInstanceId,
        codexHome: nextCodexHome
      };
      this.runners.set(k, r);
    }
    return r;
  }

  isBusy(sessionId: string, chatId: string): boolean {
    const r = this.runners.get(this.key(sessionId, chatId));
    return Boolean(r?.busy);
  }

  hasPendingApproval(sessionId: string, chatId: string): boolean {
    const r = this.runners.get(this.key(sessionId, chatId));
    return Boolean(r?.client.hasPendingApprovals());
  }

  approve(sessionId: string, chatId: string, id: string, decision: CodexApprovalDecision): boolean {
    const r = this.runners.get(this.key(sessionId, chatId));
    if (!r) return false;
    return r.client.approve(id, decision);
  }

  abort(sessionId: string, chatId: string): { ok: boolean; error?: string } {
    const r = this.runners.get(this.key(sessionId, chatId));
    if (!r || !r.busy) return { ok: false, error: 'not_running' };
    // If Codex is currently waiting on approval, aborting needs to resolve
    // that wait first; otherwise the turn may remain blocked.
    r.client.abortPendingApprovals();
    r.abort?.abort();
    return { ok: true };
  }

  reset(sessionId: string, chatId: string): { ok: boolean } {
    // Drop runner; a new one will be created on next turn.
    this.runners.delete(this.key(sessionId, chatId));
    return { ok: true };
  }

  async runTurn(opts: {
    sessionId: string;
    chatId: string;
    prompt: string;
    instance?: CodexInstanceBinding;
    config: {
      cwd?: string;
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
      approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
      model?: string;
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    };
    signal?: AbortSignal;
    onEvent: (e: CodexRunnerEvent) => void;
  }): Promise<{ usage?: CodexUsage; rateLimits?: CodexRateLimits }> {
    const r = this.get(opts.sessionId, opts.chatId, opts.instance);
    if (r.busy) throw new Error('chat_busy');
    r.busy = true;
    r.abort = new AbortController();
    const nextConfigKey = sessionConfigKey(opts.config);
    const turnStartAt = Date.now();

    try {
      // Wrap event handler so we can emit low-noise heartbeats when Codex is "thinking"
      // and not producing any deltas/events for a while.
      let lastNonProgressAt = Date.now();
      let lastHeartbeatAt = 0;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const emit = (e: CodexRunnerEvent) => {
        if (!(e.type === 'raw' && isProgressMsg(e.msg))) {
          lastNonProgressAt = Date.now();
        }
        opts.onEvent(e);
      };

      r.client.setEventHandler(emit);

      const heartbeatEveryMs = 10_000;
      heartbeatTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastNonProgressAt < heartbeatEveryMs) return;
        if (now - lastHeartbeatAt < heartbeatEveryMs) return;
        lastHeartbeatAt = now;
        emit({
          type: 'raw',
          msg: {
            type: 'progress',
            stage: 'heartbeat',
            message: `still running; quiet=${Math.max(0, Math.round((now - lastNonProgressAt) / 1000))}s; pending_approval=${r.client.hasPendingApprovals() ? 1 : 0}`,
            detail: { sinceMs: Math.max(0, now - turnStartAt) }
          }
        });
      }, 1000).unref();

      // Combine abort signals (client disconnect + explicit abort).
      const signal = opts.signal;
      if (signal) {
        if (signal.aborted) r.abort.abort();
        else signal.addEventListener('abort', () => r.abort?.abort(), { once: true });
      }

      // codex-reply does not accept sandbox/approval/cwd/model overrides.
      // When these change, we must restart the underlying Codex session.
      if (r.client.hasSession() && r.sessionConfigKey !== nextConfigKey) {
        emit({
          type: 'raw',
          msg: {
            type: 'progress',
            stage: 'session_reset',
            message: 'session config changed; resetting Codex session'
          }
        });
        r.client.resetSessionState();
      }

      let callResp;
      if (!r.client.hasSession()) {
        emit({
          type: 'raw',
          msg: {
            type: 'progress',
            stage: 'start_session',
            message: `starting new Codex session (model=${opts.config.model || 'default'}, cwd=${opts.config.cwd || '(default)'})`
          }
        });
        callResp = await r.client.startSession(
          {
            prompt: opts.prompt,
            cwd: opts.config.cwd,
            sandbox: opts.config.sandbox,
            'approval-policy': opts.config.approvalPolicy,
            model: opts.config.model,
            config: opts.config.reasoningEffort
              ? { model_reasoning_effort: opts.config.reasoningEffort }
              : undefined
          },
          { signal: r.abort.signal }
        );
        r.sessionConfigKey = nextConfigKey;
      } else {
        emit({
          type: 'raw',
          msg: {
            type: 'progress',
            stage: 'continue_session',
            message: `continuing Codex session (model=${opts.config.model || 'default'})`
          }
        });
        callResp = await r.client.continueSession(opts.prompt, { signal: r.abort.signal });
      }

      const usage = callResp ? r.client.getLastUsage() : null;
      const rateLimits = callResp ? r.client.getLastRateLimits() : null;
      return { usage: usage || undefined, rateLimits: rateLimits || undefined };
    } finally {
      try {
        // Best-effort cleanup; runTurn can error/abort mid-flight.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      } catch {
        // ignore
      }
      r.client.setEventHandler(null);
      r.busy = false;
      r.abort = undefined;
    }
  }

  getChatUsage(sessionId: string, chatId: string): CodexUsage | null {
    const r = this.runners.get(this.key(sessionId, chatId));
    return r?.client.getLastUsage() || null;
  }

  getChatRateLimits(sessionId: string, chatId: string): CodexRateLimits | null {
    const r = this.runners.get(this.key(sessionId, chatId));
    return r?.client.getLastRateLimits() || null;
  }

  getChatSessionState(
    sessionId: string,
    chatId: string
  ): { sessionId: string | null; conversationId: string | null } | null {
    const r = this.runners.get(this.key(sessionId, chatId));
    return r ? r.client.getSessionState() : null;
  }
}
