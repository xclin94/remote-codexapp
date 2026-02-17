import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  CodexApprovalDecision,
  CodexRunnerEvent,
  CodexUsage,
  CodexRateLimits
} from './codexMcpClient.js';

type SessiondStreamEvent = {
  id: number;
  event: string;
  data: any;
  ts: number;
};

type SessiondRuntime = {
  status: 'idle' | 'running' | 'done' | 'error';
  lastEventId: number;
  updatedAt: number;
  busy: boolean;
};

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  allowNotFound?: boolean;
  allowConflict?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatKey(sessionId: string, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

export class SessiondClient {
  private readonly baseUrl: string;
  private readonly autoStart: boolean;
  private readonly serverCwd: string;
  private readonly knownCursorByChat = new Map<string, number>();
  private ensureInFlight: Promise<void> | null = null;

  constructor(opts: { baseUrl: string; autoStart: boolean; serverCwd: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.autoStart = opts.autoStart;
    this.serverCwd = opts.serverCwd;
  }

  getKnownCursor(sessionId: string, chatId: string): number {
    return this.knownCursorByChat.get(chatKey(sessionId, chatId)) || 0;
  }

  markKnownCursor(sessionId: string, chatId: string, id: number): void {
    const k = chatKey(sessionId, chatId);
    const cur = this.knownCursorByChat.get(k) || 0;
    if (id > cur) this.knownCursorByChat.set(k, id);
  }

  resetKnownCursor(sessionId: string, chatId: string): void {
    this.knownCursorByChat.delete(chatKey(sessionId, chatId));
  }

  private async healthCheck(timeoutMs = 1200): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
      if (!res.ok) return false;
      const body = await res.json().catch(() => null);
      return Boolean(body?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveNpmRunCommand(): { command: string; args: string[] } {
    const raw = (process.env.npm_execpath || '').trim();
    const candidates: string[] = [];
    if (raw) {
      if (path.isAbsolute(raw)) {
        candidates.push(raw);
      } else {
        candidates.push(path.resolve(process.cwd(), raw));
        candidates.push(path.resolve(this.serverCwd, raw));
      }
    }

    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      if (candidate.endsWith('.js')) {
        return { command: process.execPath, args: [candidate, 'run', 'sessiond'] };
      }
      return { command: candidate, args: ['run', 'sessiond'] };
    }

    return { command: 'npm', args: ['run', 'sessiond'] };
  }

  private spawnSessiond(): void {
    const { command, args } = this.resolveNpmRunCommand();
    const child = spawn(command, args, {
      cwd: this.serverCwd,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.on('error', (err) => {
      console.warn(`[server] failed to spawn sessiond via ${command}: ${String((err as any)?.message || err)}`);
    });
    child.unref();
  }

  async ensureStarted(): Promise<void> {
    if (this.ensureInFlight) return this.ensureInFlight;
    this.ensureInFlight = (async () => {
      if (await this.healthCheck()) return;
      if (!this.autoStart) throw new Error('sessiond_unavailable');

      this.spawnSessiond();

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (await this.healthCheck()) return;
        await sleep(250);
      }
      throw new Error('sessiond_unavailable');
    })().finally(() => {
      this.ensureInFlight = null;
    });
    return this.ensureInFlight;
  }

  private async requestJson<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    const method = opts.method || 'GET';
    const timeoutMs = opts.timeoutMs || 4000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body ? { 'content-type': 'application/json' } : {})
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      });

      const text = await res.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!res.ok) {
        if (res.status === 404 && opts.allowNotFound) return parsed as T;
        if (res.status === 409 && opts.allowConflict) return parsed as T;
        const err = new Error(
          typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return parsed as T;
    } catch (err) {
      if (!retried) {
        await this.ensureStarted();
        return this.requestJson<T>(path, opts, true);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getRuntime(sessionId: string, chatId: string): Promise<SessiondRuntime> {
    await this.ensureStarted();
    const q = new URLSearchParams({ sessionId, chatId }).toString();
    const body = await this.requestJson<{
      ok: boolean;
      status: SessiondRuntime['status'];
      lastEventId: number;
      updatedAt: number;
      busy: boolean;
    }>(`/v1/chats/runtime?${q}`);
    return {
      status: body.status,
      lastEventId: body.lastEventId || 0,
      updatedAt: body.updatedAt || Date.now(),
      busy: Boolean(body.busy)
    };
  }

  async listEventsSince(sessionId: string, chatId: string, after: number): Promise<SessiondStreamEvent[]> {
    await this.ensureStarted();
    const q = new URLSearchParams({
      sessionId,
      chatId,
      after: String(Math.max(0, after || 0))
    }).toString();
    const body = await this.requestJson<{ ok: boolean; events: SessiondStreamEvent[] }>(`/v1/chats/events?${q}`);
    return Array.isArray(body.events) ? body.events : [];
  }

  async isBusy(sessionId: string, chatId: string): Promise<boolean> {
    const rt = await this.getRuntime(sessionId, chatId);
    return rt.status === 'running' || rt.busy;
  }

  async runTurn(opts: {
    sessionId: string;
    chatId: string;
    prompt: string;
    assistantMessageId?: string;
    instance?: {
      instanceId: string;
      codexHome?: string;
    };
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
    await this.ensureStarted();
    this.resetKnownCursor(opts.sessionId, opts.chatId);

    const startResp = await this.requestJson<{ ok?: boolean; error?: string }>(
      '/v1/chats/start',
      {
        method: 'POST',
        body: {
          sessionId: opts.sessionId,
          chatId: opts.chatId,
          prompt: opts.prompt,
          assistantMessageId: opts.assistantMessageId,
          instance: opts.instance,
          config: opts.config
        },
        allowConflict: true
      }
    );
    if (startResp?.ok !== true) {
      const msg = typeof startResp?.error === 'string' ? startResp.error : 'start_failed';
      throw new Error(msg);
    }

    let after = 0;
    let usage: CodexUsage | undefined;
    let rateLimits: CodexRateLimits | undefined;
    let lastTurnErrorMessage = '';

    while (true) {
      if (opts.signal?.aborted) {
        await this.abort(opts.sessionId, opts.chatId).catch(() => undefined);
        throw new Error('aborted');
      }

      const events = await this.listEventsSince(opts.sessionId, opts.chatId, after);
      for (const e of events) {
        after = e.id;
        this.markKnownCursor(opts.sessionId, opts.chatId, e.id);
        if (e.event === 'progress') {
          // Forward as a structured raw event so the main server can display it.
          if (typeof e.data === 'object' && e.data !== null) {
            opts.onEvent({ type: 'raw', msg: { type: 'progress', ...(e.data as any) } });
          } else {
            opts.onEvent({ type: 'raw', msg: { type: 'progress', stage: 'progress', message: String(e.data || '') } });
          }
          continue;
        }
        if (e.event === 'delta' && typeof e.data?.text === 'string') {
          opts.onEvent({ type: 'agent_message', message: e.data.text });
          continue;
        }
        if (e.event === 'approval_request') {
          opts.onEvent({ type: 'approval_request', request: e.data });
          continue;
        }
        if (e.event === 'codex_event') {
          opts.onEvent({ type: 'raw', msg: e.data });
          continue;
        }
        if (e.event === 'codex_usage' && typeof e.data === 'object' && e.data !== null) {
          usage = e.data as CodexUsage;
          continue;
        }
        if (e.event === 'codex_rate_limits' && typeof e.data === 'object' && e.data !== null) {
          rateLimits = e.data as CodexRateLimits;
          continue;
        }
        if (e.event === 'turn_error') {
          lastTurnErrorMessage =
            typeof e.data?.message === 'string' ? e.data.message : 'codex_error';
        }
      }

      const rt = await this.getRuntime(opts.sessionId, opts.chatId);
      if (after > rt.lastEventId) {
        // A newer turn replaced stream history; restart cursor for this turn view.
        after = 0;
        this.resetKnownCursor(opts.sessionId, opts.chatId);
      }
      if (rt.status === 'done') return { usage, rateLimits };
      if (rt.status === 'error') {
        throw new Error(lastTurnErrorMessage || 'codex_error');
      }
      await sleep(180);
    }
  }

  async approve(
    sessionId: string,
    chatId: string,
    id: string,
    decision: CodexApprovalDecision
  ): Promise<boolean> {
    const resp = await this.requestJson<{ ok?: boolean }>(
      '/v1/chats/approve',
      {
        method: 'POST',
        body: { sessionId, chatId, id, decision },
        allowNotFound: true
      }
    );
    return Boolean(resp?.ok);
  }

  async abort(sessionId: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await this.requestJson<{ ok?: boolean; error?: string }>(
      '/v1/chats/abort',
      {
        method: 'POST',
        body: { sessionId, chatId },
        allowConflict: true
      }
    );
    if (resp?.ok) return { ok: true };
    return { ok: false, error: typeof resp?.error === 'string' ? resp.error : 'abort_failed' };
  }

  async reset(sessionId: string, chatId: string): Promise<{ ok: boolean }> {
    await this.requestJson<{ ok?: boolean }>(
      '/v1/chats/reset',
      {
        method: 'POST',
        body: { sessionId, chatId }
      }
    );
    this.resetKnownCursor(sessionId, chatId);
    return { ok: true };
  }

  async getChatUsage(sessionId: string, chatId: string): Promise<CodexUsage | null> {
    const q = new URLSearchParams({ sessionId, chatId }).toString();
    const body = await this.requestJson<{ ok: boolean; usage: CodexUsage | null }>(`/v1/chats/usage?${q}`);
    return body.usage || null;
  }

  async getChatRateLimits(sessionId: string, chatId: string): Promise<CodexRateLimits | null> {
    const q = new URLSearchParams({ sessionId, chatId }).toString();
    const body = await this.requestJson<{ ok: boolean; rateLimits: CodexRateLimits | null }>(
      `/v1/chats/rate-limits?${q}`
    );
    return body.rateLimits || null;
  }

  async getChatSessionState(
    sessionId: string,
    chatId: string
  ): Promise<{ sessionId: string | null; conversationId: string | null } | null> {
    const q = new URLSearchParams({ sessionId, chatId }).toString();
    const body = await this.requestJson<{
      ok: boolean;
      session?: { sessionId?: string | null; conversationId?: string | null } | null;
    }>(`/v1/chats/session?${q}`);
    if (!body?.session) return null;
    return {
      sessionId: typeof body.session.sessionId === 'string' ? body.session.sessionId : null,
      conversationId: typeof body.session.conversationId === 'string' ? body.session.conversationId : null
    };
  }
}
