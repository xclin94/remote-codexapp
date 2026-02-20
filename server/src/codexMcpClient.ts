import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export type CodexUsage = Record<string, unknown>;
export type CodexRateLimits = Record<string, unknown>;

export type CodexApprovalDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

export type CodexApprovalRequest = {
  id: string;
  message?: string;
  command?: string[];
  cwd?: string;
};

export type CodexRunnerEvent =
  | { type: 'agent_message'; message: string }
  | { type: 'approval_request'; request: CodexApprovalRequest }
  | { type: 'raw'; msg: any };

export type CodexSessionConfig = {
  prompt: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  model?: string;
  config?: Record<string, any>;
};

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null;
}

type AgentBackend = 'codex' | 'claude';
type ClaudeEffort = 'low' | 'medium' | 'high';

function resolveBackend(raw: unknown): AgentBackend {
  if (typeof raw !== 'string') return 'codex';
  const v = raw.trim().toLowerCase();
  return v === 'claude' ? 'claude' : 'codex';
}

export class CodexMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private readonly backend: AgentBackend;
  private readonly envOverrides: Record<string, string>;
  private activeClaudeProc: ChildProcess | null = null;

  private sessionId: string | null = null;
  private conversationId: string | null = null;

  private onEvent: ((e: CodexRunnerEvent) => void) | null = null;
  private pendingApprovals = new Map<string, (d: CodexApprovalDecision) => void>();
  private sawAssistantTextInFlight = false;
  private approvalSeq = 0;
  private lastUsage: CodexUsage | null = null;
  private lastRateLimits: CodexRateLimits | null = null;

  constructor(opts?: { env?: Record<string, string> }) {
    this.envOverrides = opts?.env ? { ...opts.env } : {};
    this.backend = resolveBackend(this.envOverrides.CODEX_BACKEND ?? process.env.CODEX_BACKEND);
    if (this.backend !== 'codex') return;

    this.client = new Client(
      { name: 'codex-remoteapp', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );

    // Codex emits notifications with method "codex/event".
    this.client.setNotificationHandler(
      z
        .object({
          method: z.literal('codex/event'),
          params: z.object({ msg: z.any() }).passthrough()
        })
      .passthrough(),
      (data) => {
        const msg = (data as any).params?.msg;
      this.updateIdentifiersFromEvent(msg);
      const usageFromMsg = this.extractUsage(msg);
      if (usageFromMsg) this.lastUsage = usageFromMsg;
      const rateLimitsFromMsg = this.extractRateLimits(msg);
      if (rateLimitsFromMsg) this.lastRateLimits = rateLimitsFromMsg;

        // Stream assistant text exactly once.
        // Codex typically emits both:
        // - agent_message_delta (primary)
        // - agent_message_content_delta (duplicate)
        // Plus sometimes a final full message. We avoid double-appending.
        if (isObj(msg) && msg.type === 'agent_message_delta' && typeof msg.delta === 'string') {
          this.onEvent?.({ type: 'agent_message', message: msg.delta });
          this.sawAssistantTextInFlight = true;
          return;
        }
        if (isObj(msg) && msg.type === 'agent_message_content_delta' && typeof msg.delta === 'string') {
          // Ignore (duplicates agent_message_delta).
          return;
        }
        if (
          isObj(msg) &&
          msg.type === 'agent_message' &&
          typeof msg.message === 'string' &&
          !this.sawAssistantTextInFlight
        ) {
          this.onEvent?.({ type: 'agent_message', message: msg.message });
          this.sawAssistantTextInFlight = true;
          return;
        }
        if (
          isObj(msg) &&
          msg.type === 'raw_response_item' &&
          !this.sawAssistantTextInFlight &&
          isObj(msg.item) &&
          msg.item.role === 'assistant' &&
          Array.isArray(msg.item.content)
        ) {
          for (const c of msg.item.content) {
            if (isObj(c) && c.type === 'output_text' && typeof c.text === 'string' && c.text.length) {
              this.onEvent?.({ type: 'agent_message', message: c.text });
              this.sawAssistantTextInFlight = true;
              return;
            }
          }
        }

        this.onEvent?.({ type: 'raw', msg });
      }
    );
  }

  setEventHandler(handler: ((e: CodexRunnerEvent) => void) | null) {
    this.onEvent = handler;
  }

  getLastUsage(): CodexUsage | null {
    return this.lastUsage;
  }

  getLastRateLimits(): CodexRateLimits | null {
    return this.lastRateLimits;
  }

  private nextApprovalId(): string {
    this.approvalSeq += 1;
    return `${Date.now()}-${this.approvalSeq}`;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.backend === 'claude') {
      this.connected = true;
      return;
    }
    const client = this.client;
    if (!client) throw new Error('codex_client_unavailable');

    const mergedEnv = this.buildMergedEnv();

    this.transport = new StdioClientTransport({
      command: 'codex',
      args: ['mcp-server'],
      env: mergedEnv
    });

    // Permission requests come via MCP elicitation.
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const p: any = request.params;
      const approvalId = String(p?.codex_call_id || p?.codex_mcp_tool_call_id || p?.codex_event_id || '');
      const id = approvalId || this.nextApprovalId();

      const req: CodexApprovalRequest = {
        id,
        message: typeof p?.message === 'string' ? p.message : undefined,
        command: Array.isArray(p?.codex_command) ? p.codex_command.map(String) : undefined,
        cwd: typeof p?.codex_cwd === 'string' ? p.codex_cwd : undefined
      };

    const decision = await new Promise<CodexApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.onEvent?.({ type: 'approval_request', request: req });
    });

    this.pendingApprovals.delete(id);
    return this.toElicitResponse(decision);
  });

    await client.connect(this.transport);
    this.connected = true;
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  getSessionState(): { sessionId: string | null; conversationId: string | null } {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId
    };
  }

  hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0;
  }

  abortPendingApprovals(): number {
    const resolvers = Array.from(this.pendingApprovals.values());
    this.pendingApprovals.clear();
    for (const resolve of resolvers) {
      resolve('abort');
    }
    this.stopActiveClaudeProcess();
    return resolvers.length;
  }

  resetSessionState(): void {
    // If a run is paused on approval while session settings changed, unblock it.
    this.abortPendingApprovals();
    this.sessionId = null;
    this.conversationId = null;
    this.sawAssistantTextInFlight = false;
    this.lastUsage = null;
    this.lastRateLimits = null;
  }

  approve(id: string, decision: CodexApprovalDecision): boolean {
    let pendingApprovalKey: string | null = id;
    let resolver = this.pendingApprovals.get(pendingApprovalKey);

    // Be tolerant to clients sending a different id format when the id in the
    // request payload is absent or temporarily mismatched.
    if (!resolver && this.pendingApprovals.size === 1) {
      const fallback = this.pendingApprovals.keys().next().value as string | undefined;
      if (fallback) {
        resolver = this.pendingApprovals.get(fallback);
        pendingApprovalKey = fallback;
      }
    }

    if (!resolver) return false;

    resolver(decision);
    if (pendingApprovalKey) this.pendingApprovals.delete(pendingApprovalKey);
    return true;
  }

  private toElicitResponse(decision: CodexApprovalDecision): { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } {
    switch (decision) {
      case 'approved':
      case 'approved_for_session':
        return { action: 'accept' };
      case 'denied':
        return { action: 'decline' };
      case 'abort':
      default:
        return { action: 'cancel' };
    }
  }

  async startSession(config: CodexSessionConfig, opts?: { signal?: AbortSignal }) {
    await this.connect();
    this.lastUsage = null;
    this.lastRateLimits = null;
    this.sawAssistantTextInFlight = false;
    if (this.backend === 'claude') {
      await this.runClaudeTurn(
        {
          prompt: config.prompt,
          cwd: config.cwd,
          model: config.model,
          effort: this.resolveClaudeEffort(config.config),
          signal: opts?.signal
        }
      );
      return {
        ok: true,
        meta: {
          sessionId: this.sessionId,
          conversationId: this.conversationId || this.sessionId
        }
      } as any;
    }
    const client = this.client;
    if (!client) throw new Error('codex_client_unavailable');

    const resp = await client.callTool(
      { name: 'codex', arguments: config as any },
      undefined,
      { signal: opts?.signal, timeout: 7 * 24 * 60 * 60 * 1000 }
    );
    this.extractIdentifiers(resp);
    const usageFromResp = this.extractUsage(resp);
    if (usageFromResp) this.lastUsage = usageFromResp;
    const rateLimitsFromResp = this.extractRateLimits(resp);
    if (rateLimitsFromResp) this.lastRateLimits = rateLimitsFromResp;
    return resp as any;
  }

  async continueSession(prompt: string, opts?: { signal?: AbortSignal }) {
    await this.connect();
    if (!this.sessionId) throw new Error('missing sessionId');
    if (!this.conversationId) this.conversationId = this.sessionId;

    this.lastUsage = null;
    this.lastRateLimits = null;
    this.sawAssistantTextInFlight = false;
    if (this.backend === 'claude') {
      await this.runClaudeTurn({
        prompt,
        model: undefined,
        resumeSessionId: this.sessionId,
        signal: opts?.signal
      });
      return {
        ok: true,
        meta: {
          sessionId: this.sessionId,
          conversationId: this.conversationId || this.sessionId
        }
      } as any;
    }
    const client = this.client;
    if (!client) throw new Error('codex_client_unavailable');

    const resp = await client.callTool(
      { name: 'codex-reply', arguments: { sessionId: this.sessionId, conversationId: this.conversationId, prompt } as any },
      undefined,
      { signal: opts?.signal, timeout: 7 * 24 * 60 * 60 * 1000 }
    );
    this.extractIdentifiers(resp);
    const usageFromResp = this.extractUsage(resp);
    if (usageFromResp) this.lastUsage = usageFromResp;
    const rateLimitsFromResp = this.extractRateLimits(resp);
    if (rateLimitsFromResp) this.lastRateLimits = rateLimitsFromResp;
    return resp as any;
  }

  private buildMergedEnv(): Record<string, string> {
    const mergedEnv = Object.keys(process.env).reduce((acc, k) => {
      const v = process.env[k];
      if (typeof v === 'string') acc[k] = v;
      return acc;
    }, {} as Record<string, string>);
    for (const [k, v] of Object.entries(this.envOverrides)) {
      mergedEnv[k] = v;
    }
    return mergedEnv;
  }

  private resolveClaudeEffort(config: Record<string, any> | undefined): ClaudeEffort | null {
    const raw = typeof config?.model_reasoning_effort === 'string'
      ? config.model_reasoning_effort.trim().toLowerCase()
      : '';
    if (!raw) return null;
    if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
    if (raw === 'xhigh') return 'high';
    return null;
  }

  private stopActiveClaudeProcess(target?: ChildProcess): void {
    const proc = target || this.activeClaudeProc;
    if (!proc) return;
    if (proc.exitCode === null && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      const killer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 1200);
      killer.unref();
    }
    if (this.activeClaudeProc === proc) this.activeClaudeProc = null;
  }

  private extractClaudeAssistantText(payload: any): string {
    const msg = payload?.message;
    if (!isObj(msg)) return '';
    const content = (msg as any).content;
    if (!Array.isArray(content)) return '';
    const chunks: string[] = [];
    for (const item of content) {
      if (isObj(item) && item.type === 'text' && typeof item.text === 'string' && item.text.length) {
        chunks.push(item.text);
      }
    }
    return chunks.join('');
  }

  private handleClaudeJsonLine(payload: any): void {
    this.updateIdentifiersFromEvent(payload);
    if (!this.conversationId && this.sessionId) this.conversationId = this.sessionId;

    const usage = this.extractUsage(payload);
    if (usage) this.lastUsage = usage;

    if (isObj(payload) && payload.type === 'stream_event' && isObj(payload.event)) {
      const ev = payload.event;
      const delta = isObj(ev.delta) ? ev.delta : null;
      if (ev.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.onEvent?.({ type: 'agent_message', message: delta.text });
        this.sawAssistantTextInFlight = true;
      }
    }

    if (isObj(payload) && payload.type === 'assistant' && !this.sawAssistantTextInFlight) {
      const text = this.extractClaudeAssistantText(payload);
      if (text) {
        this.onEvent?.({ type: 'agent_message', message: text });
        this.sawAssistantTextInFlight = true;
      }
    }

    this.onEvent?.({ type: 'raw', msg: { type: 'claude_event', data: payload } });
  }

  private async runClaudeTurn(opts: {
    prompt: string;
    cwd?: string;
    model?: string;
    effort?: ClaudeEffort | null;
    resumeSessionId?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    if (typeof opts.model === 'string' && opts.model.trim()) args.push('--model', opts.model.trim());
    if (opts.effort) args.push('--effort', opts.effort);
    args.push(opts.prompt);

    const child = spawn('claude', args, {
      cwd: typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd.trim() : undefined,
      env: this.buildMergedEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.activeClaudeProc = child;

    const stdoutRl = readline.createInterface({ input: child.stdout });
    const stderrRl = readline.createInterface({ input: child.stderr });
    const stderrTail: string[] = [];
    const keepStderr = (line: string) => {
      const t = line.trim();
      if (!t) return;
      stderrTail.push(t);
      if (stderrTail.length > 8) stderrTail.shift();
    };
    stderrRl.on('line', keepStderr);

    const onStdoutLine = (line: string) => {
      const raw = line.trim();
      if (!raw) return;
      try {
        this.handleClaudeJsonLine(JSON.parse(raw));
      } catch {
        this.onEvent?.({ type: 'raw', msg: { type: 'claude_stdout', line: raw } });
      }
    };
    stdoutRl.on('line', onStdoutLine);

    const abortHandler = () => {
      this.stopActiveClaudeProcess(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', (err) => reject(err));
        child.once('close', (code) => {
          if (opts.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          if (code === 0) {
            resolve();
            return;
          }
          const tail = stderrTail.join(' | ');
          reject(new Error(tail || `claude_exit_${code}`));
        });
      });
    } finally {
      stdoutRl.close();
      stderrRl.close();
      if (opts.signal) opts.signal.removeEventListener('abort', abortHandler);
      if (this.activeClaudeProc === child) this.activeClaudeProc = null;
    }
  }

  private updateIdentifiersFromEvent(event: any) {
    if (!isObj(event)) return;
    const cand = [event, isObj(event.data) ? event.data : null].filter(Boolean) as any[];
    for (const c of cand) {
      const sid = c.session_id ?? c.sessionId;
      if (sid) this.sessionId = String(sid);
      const cid = c.conversation_id ?? c.conversationId;
      if (cid) this.conversationId = String(cid);
    }
  }

  private extractIdentifiers(resp: any) {
    const meta = resp?.meta || {};
    if (meta.sessionId) this.sessionId = String(meta.sessionId);
    if (meta.conversationId) this.conversationId = String(meta.conversationId);

    const content = resp?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!this.sessionId && item?.sessionId) this.sessionId = String(item.sessionId);
        if (!this.conversationId && item?.conversationId) this.conversationId = String(item.conversationId);
      }
    }
  }

  private extractUsage(v: any): CodexUsage | null {
    const asObj = (x: unknown): CodexUsage | null => {
      if (!isObj(x)) return null;
      return x as CodexUsage;
    };

    const direct = asObj((v as any).usage) || asObj((v as any).meta?.usage) || asObj((v as any).meta?.usageDetails);
    if (direct) return direct;

    const info = asObj((v as any).info);
    if (info) {
      const tokenUsage = asObj((info as any).usage) || asObj((info as any).total_token_usage) || asObj((info as any).last_token_usage);
      if (tokenUsage) return tokenUsage;
    }

    if (Array.isArray((v as any).content)) {
      for (const item of (v as any).content) {
        const usage = asObj(item?.usage) || asObj(item?.metadata?.usage) || asObj(item?.meta?.usage);
        if (usage) return usage;
      }
    }

    return null;
  }

  private extractRateLimits(v: any): CodexRateLimits | null {
    const searchRec = (node: unknown, depth = 0, seen = new Set<unknown>()): CodexRateLimits | null => {
      if (depth > 8) return null;
      if (!isObj(node)) return null;
      if (seen.has(node)) return null;
      seen.add(node);

      const asObj = (x: unknown): CodexRateLimits | null => (isObj(x) ? (x as CodexRateLimits) : null);
      const current = asObj(node);
      if (!current) return null;

      const direct =
        asObj((current as Record<string, unknown>).rate_limits) ||
        asObj((current as Record<string, unknown>).rateLimits) ||
        asObj((current as Record<string, unknown>).rate_limits_raw) ||
        asObj((current as Record<string, unknown>).rateLimitsRaw);
      if (direct) return direct;

      const usage = asObj((current as Record<string, unknown>).usage);
      if (usage) {
        const fromUsage = asObj((usage as Record<string, unknown>).rate_limits) || asObj((usage as Record<string, unknown>).rateLimits);
        if (fromUsage) return fromUsage;
      }

      const meta = asObj((current as Record<string, unknown>).meta);
      if (meta) {
        const fromMeta = asObj((meta as Record<string, unknown>).rate_limits) || asObj((meta as Record<string, unknown>).rateLimits);
        if (fromMeta) return fromMeta;
      }

      const info = asObj((current as Record<string, unknown>).info);
      if (info) {
        const fromInfo = asObj((info as Record<string, unknown>).rate_limits) || asObj((info as Record<string, unknown>).rateLimits);
        if (fromInfo) return fromInfo;
      }

      for (const value of Object.values(current)) {
        const found = searchRec(value, depth + 1, seen);
        if (found) return found;
      }
      return null;
    };

    return searchRec(v);
  }
}
