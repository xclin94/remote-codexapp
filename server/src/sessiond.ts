import './bootstrapEnv.js';

import express from 'express';
import { z } from 'zod';

import { readEnv } from './config.js';
import { CodexManager } from './codexManager.js';

type StreamEvent = {
  id: number;
  event: string;
  data: any;
  ts: number;
};

function isProgressMsg(msg: unknown): msg is { type: 'progress'; stage?: unknown; message?: unknown; detail?: unknown } {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'progress';
}

type ChatStream = {
  status: 'idle' | 'running' | 'done' | 'error';
  nextId: number;
  events: StreamEvent[];
  updatedAt: number;
};

const env = readEnv();
const codex = new CodexManager();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const streamsByChatKey = new Map<string, ChatStream>();

function nowMs(): number {
  return Date.now();
}

function chatKey(sessionId: string, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

function ensureStream(sessionId: string, chatId: string): ChatStream {
  const key = chatKey(sessionId, chatId);
  let s = streamsByChatKey.get(key);
  if (!s) {
    s = { status: 'idle', nextId: 1, events: [], updatedAt: nowMs() };
    streamsByChatKey.set(key, s);
  }
  return s;
}

function resetStream(sessionId: string, chatId: string): ChatStream {
  const key = chatKey(sessionId, chatId);
  const s = ensureStream(sessionId, chatId);
  s.status = 'running';
  s.nextId = 1;
  s.events = [];
  s.updatedAt = nowMs();
  streamsByChatKey.set(key, s);
  return s;
}

function appendStreamEvent(sessionId: string, chatId: string, event: string, data: any): StreamEvent {
  const key = chatKey(sessionId, chatId);
  const s = ensureStream(sessionId, chatId);
  const e: StreamEvent = { id: s.nextId++, event, data, ts: nowMs() };
  s.events.push(e);
  if (event === 'done') s.status = 'done';
  if (event === 'turn_error' || event === 'error') s.status = 'error';
  s.updatedAt = nowMs();
  const maxEvents = 4000;
  if (s.events.length > maxEvents) {
    s.events.splice(0, s.events.length - maxEvents);
  }
  streamsByChatKey.set(key, s);
  return e;
}

function listStreamEventsSince(sessionId: string, chatId: string, afterId: number): StreamEvent[] {
  const s = ensureStream(sessionId, chatId);
  return s.events.filter((e) => e.id > afterId);
}

function getStreamRuntime(
  sessionId: string,
  chatId: string
): { status: ChatStream['status']; lastEventId: number; updatedAt: number } {
  const s = ensureStream(sessionId, chatId);
  const lastEventId = Math.max(0, s.nextId - 1);
  return { status: s.status, lastEventId, updatedAt: s.updatedAt };
}

setInterval(() => {
  const t = nowMs();
  const idleTtlMs = 12 * 60 * 60 * 1000;
  for (const [key, s] of streamsByChatKey) {
    if (s.status !== 'running' && s.updatedAt + idleTtlMs <= t) {
      streamsByChatKey.delete(key);
      continue;
    }
    if (s.status === 'running') {
      const [sid, cid] = key.split(':');
      if (!sid || !cid) continue;
      if (!codex.isBusy(sid, cid)) {
        appendStreamEvent(sid, cid, 'done', { ok: true, reconciled: true });
      }
    }
  }
}, 30_000).unref();

const StartSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
  prompt: z.string().min(1),
  assistantMessageId: z.string().min(1).optional(),
  instance: z.object({
    instanceId: z.string().min(1),
    codexHome: z.string().min(1).optional(),
    backend: z.enum(['codex', 'claude']).optional()
  }).optional(),
  config: z.object({
    cwd: z.string().optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
    model: z.string().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional()
  })
});

const RuntimeQuerySchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1)
});

const EventsQuerySchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
  after: z.coerce.number().int().min(0).optional()
});

const ApproveSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
  id: z.string().min(1),
  decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort'])
});

const AbortSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1)
});

const UsageQuerySchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1)
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, pid: process.pid, time: nowMs() });
});

app.post('/v1/chats/start', (req, res) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const { sessionId, chatId, prompt, assistantMessageId, instance, config } = parsed.data;

  if (codex.isBusy(sessionId, chatId)) {
    return res.status(409).json({ ok: false, error: 'chat_busy' });
  }

  resetStream(sessionId, chatId);
  appendStreamEvent(sessionId, chatId, 'start', {
    ok: true,
    assistantMessageId: assistantMessageId || null,
    instanceId: instance?.instanceId || null
  });

  void (async () => {
    try {
      const runResp = await codex.runTurn({
        sessionId,
        chatId,
        prompt,
        instance: instance
          ? {
            instanceId: instance.instanceId,
            codexHome: instance.codexHome,
            backend: instance.backend
          }
          : undefined,
        config: {
          cwd: config.cwd,
          sandbox: config.sandbox,
          approvalPolicy: config.approvalPolicy,
          model: config.model,
          reasoningEffort: config.reasoningEffort
        },
        onEvent: (e) => {
          if (e.type === 'agent_message') {
            appendStreamEvent(sessionId, chatId, 'delta', {
              text: e.message,
              assistantMessageId: assistantMessageId || null
            });
            return;
          }
          if (e.type === 'approval_request') {
            appendStreamEvent(sessionId, chatId, 'approval_request', e.request);
            return;
          }
          if (e.type === 'raw' && isProgressMsg(e.msg)) {
            const stage = typeof (e.msg as any).stage === 'string' ? String((e.msg as any).stage) : 'progress';
            const message = typeof (e.msg as any).message === 'string' ? String((e.msg as any).message) : '';
            appendStreamEvent(sessionId, chatId, 'progress', {
              stage,
              message,
              detail: (e.msg as any).detail ?? null
            });
            return;
          }
          appendStreamEvent(sessionId, chatId, 'codex_event', e.msg);
        }
      });

      if (runResp.usage) appendStreamEvent(sessionId, chatId, 'codex_usage', runResp.usage);
      if (runResp.rateLimits) appendStreamEvent(sessionId, chatId, 'codex_rate_limits', runResp.rateLimits);
      appendStreamEvent(sessionId, chatId, 'done', { ok: true });
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'codex_error';
      appendStreamEvent(sessionId, chatId, 'turn_error', { message: msg });
    }
  })();

  res.json({ ok: true });
});

app.get('/v1/chats/runtime', (req, res) => {
  const parsed = RuntimeQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const { sessionId, chatId } = parsed.data;

  const rt = getStreamRuntime(sessionId, chatId);
  const busy = codex.isBusy(sessionId, chatId);
  if (rt.status === 'running' && !busy) {
    appendStreamEvent(sessionId, chatId, 'done', { ok: true, reconciled: true });
  }
  const nextRt = getStreamRuntime(sessionId, chatId);
  res.json({ ok: true, ...nextRt, busy: codex.isBusy(sessionId, chatId) });
});

app.get('/v1/chats/events', (req, res) => {
  const parsed = EventsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const { sessionId, chatId } = parsed.data;
  const after = parsed.data.after || 0;
  const events = listStreamEventsSince(sessionId, chatId, after);
  res.json({ ok: true, events });
});

app.get('/v1/chats/usage', (req, res) => {
  const parsed = UsageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const { sessionId, chatId } = parsed.data;
  res.json({ ok: true, usage: codex.getChatUsage(sessionId, chatId) || null });
});

app.get('/v1/chats/rate-limits', (req, res) => {
  const parsed = UsageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const { sessionId, chatId } = parsed.data;
  res.json({ ok: true, rateLimits: codex.getChatRateLimits(sessionId, chatId) || null });
});

app.get('/v1/chats/session', (req, res) => {
  const parsed = UsageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const { sessionId, chatId } = parsed.data;
  const state = codex.getChatSessionState(sessionId, chatId) || { sessionId: null, conversationId: null };
  res.json({ ok: true, session: state });
});

app.post('/v1/chats/abort', (req, res) => {
  const parsed = AbortSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const r = codex.abort(parsed.data.sessionId, parsed.data.chatId);
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error || 'abort_failed' });
  res.json({ ok: true });
});

app.post('/v1/chats/reset', (req, res) => {
  const parsed = AbortSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  codex.reset(parsed.data.sessionId, parsed.data.chatId);
  resetStream(parsed.data.sessionId, parsed.data.chatId);
  ensureStream(parsed.data.sessionId, parsed.data.chatId).status = 'idle';
  res.json({ ok: true });
});

app.post('/v1/chats/approve', (req, res) => {
  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const ok = codex.approve(parsed.data.sessionId, parsed.data.chatId, parsed.data.id, parsed.data.decision);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.listen(env.CODEX_SESSIOND_PORT, env.CODEX_SESSIOND_HOST, () => {
  console.log(
    `[sessiond] listening on http://${env.CODEX_SESSIOND_HOST}:${env.CODEX_SESSIOND_PORT} (pid=${process.pid})`
  );
});
