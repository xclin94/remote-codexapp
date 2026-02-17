import './bootstrapEnv.js';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import qrcode from 'qrcode-terminal';
import { authenticator } from 'otplib';
import pty, { type IPty } from 'node-pty';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { readEnv } from './config.js';
import {
  MemoryStore,
  type ChatMessage,
  type StreamEvent,
  type TerminalSessionRecord
} from './store.js';
import { SessiondClient } from './sessiondClient.js';

const serverRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = readEnv();

const store = new MemoryStore({
  sessionTtlMs: env.SESSION_TTL_MS,
  persistencePath: path.resolve(serverRootDir, env.DATA_DIR, 'store.json')
});

const codex = new SessiondClient({
  baseUrl: `http://${env.CODEX_SESSIOND_HOST}:${env.CODEX_SESSIOND_PORT}`,
  autoStart: env.CODEX_SESSIOND_AUTO_START,
  serverCwd: serverRootDir
});
const localTurnPumps = new Set<string>();
void codex.ensureStarted().catch((err: any) => {
  const msg = err?.message ? String(err.message) : 'sessiond_unavailable';
  console.warn(`[server] sessiond bootstrap warning: ${msg}`);
});

setInterval(() => store.sweep(), 30_000).unref();

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type CodexModelOption = {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

type CliStatusUsageResult = {
  usage: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
  error?: string;
};

type CliHistoryStatusSnapshot = {
  usage: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
  sourcePath: string;
  timestampMs: number;
};

type TerminalRuntime = {
  sid: string;
  record: TerminalSessionRecord;
  pty: IPty;
  clients: Set<WebSocket>;
};

const terminalRuntimeById = new Map<string, TerminalRuntime>();
const terminalWss = new WebSocketServer({ noServer: true });

const CLI_HISTORY_CACHE_TTL_MS = 1_500;
const CLI_HISTORY_SCAN_FILE_LIMIT = 200;
const COMPACT_KEEP_LAST_DEFAULT = 8;
const COMPACT_SUMMARY_MAX_CHARS = 2_000;
let cliHistorySnapshotCache: { expiresAt: number; snapshot: CliHistoryStatusSnapshot | null } | null = null;

function normalizeCompactKeep(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return COMPACT_KEEP_LAST_DEFAULT;
  return Math.max(0, Math.floor(n));
}

function summarizeChatForCompact(messages: ChatMessage[]): string {
  const safe = Array.isArray(messages) ? messages : [];
  if (safe.length === 0) return '';
  const raw = safe
    .map((m) => {
      const role = m.role === 'system' || m.role === 'assistant' || m.role === 'user' ? m.role : 'assistant';
      const text = typeof m.text === 'string' ? m.text : '';
      const clipped = text.length > 260 ? `${text.slice(0, 257)}...` : text;
      return `[${role}] ${clipped}`;
    })
    .join('\n');
  return raw.length > COMPACT_SUMMARY_MAX_CHARS ? `${raw.slice(0, COMPACT_SUMMARY_MAX_CHARS)}...` : raw;
}

function buildCompactedMessages(messages: ChatMessage[], keepLast: number): { messages: ChatMessage[]; removedCount: number } {
  const history = Array.isArray(messages) ? messages : [];
  const keep = normalizeCompactKeep(keepLast) > 0 ? history.slice(-normalizeCompactKeep(keepLast)) : [];
  const toCompact = history.length > keep.length ? history.slice(0, history.length - keep.length) : [];
  if (toCompact.length === 0) return { messages: keep, removedCount: 0 };

  const summaryText = summarizeChatForCompact(toCompact);
  const compactSummary: ChatMessage = {
    id: `compact-${Date.now()}`,
    role: 'system',
    text: `Conversation compacted. Summary of ${toCompact.length} earlier messages:\n${summaryText}`,
    createdAt: Date.now()
  };

  return {
    messages: [compactSummary, ...keep],
    removedCount: toCompact.length
  };
}

function parseCookieHeader(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const chunk of raw.split(';')) {
    const part = chunk.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function readSessionIdFromUpgradeRequest(req: IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie;
  const cookieValue = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const cookies = parseCookieHeader(cookieValue);
  const rawSid = cookies.sid;
  if (!rawSid) return null;

  let sid: string | null = null;
  if (rawSid.startsWith('s:')) {
    const unsigned = cookieParser.signedCookie(rawSid, env.SESSION_SECRET);
    if (typeof unsigned === 'string') sid = unsigned;
  } else {
    sid = rawSid;
  }

  if (!sid) return null;
  const session = store.getSession(sid);
  if (!session) return null;
  store.refreshSession(sid);
  return sid;
}

function rejectUpgrade(socket: net.Socket, code: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function shellForTerminal(): { command: string; args: string[] } {
  const shell = process.env.SHELL?.trim();
  if (shell) {
    return { command: shell, args: process.platform === 'win32' ? [] : ['-l'] };
  }
  if (process.platform === 'win32') return { command: 'powershell.exe', args: [] };
  return { command: '/bin/bash', args: ['-l'] };
}

function bindTerminalSocket(socket: WebSocket, runtime: TerminalRuntime): void {
  runtime.clients.add(socket);

  socket.on('message', (raw) => {
    const text = rawDataToString(raw);
    if (!text) return;
    if (text.startsWith('{')) {
      try {
        const payload = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        if (payload.type === 'resize') {
          const cols = Math.max(2, Math.floor(Number(payload.cols)));
          const rows = Math.max(1, Math.floor(Number(payload.rows)));
          if (Number.isFinite(cols) && Number.isFinite(rows)) runtime.pty.resize(cols, rows);
          return;
        }
      } catch {
        // Fallback to write raw text into the terminal.
      }
    }
    runtime.pty.write(text);
  });

  socket.on('close', () => {
    runtime.clients.delete(socket);
  });

  socket.on('error', () => {
    runtime.clients.delete(socket);
  });
}

function createTerminalRuntime(sid: string, cwd: string): TerminalSessionRecord {
  const record = store.createTerminalSession(sid, cwd);
  const shell = shellForTerminal();
  const child = pty.spawn(shell.command, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const runtime: TerminalRuntime = {
    sid,
    record,
    pty: child,
    clients: new Set<WebSocket>()
  };
  terminalRuntimeById.set(record.id, runtime);

  child.onData((chunk) => {
    for (const client of runtime.clients) {
      if (client.readyState === 1) client.send(chunk);
    }
  });

  child.onExit(() => {
    runtime.record.status = 'stopped';
    store.setTerminalSessionStopped(sid, runtime.record.id);
    terminalRuntimeById.delete(runtime.record.id);
    for (const client of runtime.clients) {
      try {
        client.close(1011, 'terminal_exited');
      } catch {
        // ignore close failures
      }
    }
    runtime.clients.clear();
  });

  return record;
}

function disposeTerminalRuntime(terminalId: string): void {
  const runtime = terminalRuntimeById.get(terminalId);
  if (!runtime) return;

  runtime.record.status = 'stopped';
  store.setTerminalSessionStopped(runtime.sid, runtime.record.id);
  terminalRuntimeById.delete(terminalId);
  for (const client of runtime.clients) {
    try {
      client.close(1000, 'terminal_closed');
    } catch {
      // ignore close failures
    }
  }
  runtime.clients.clear();
  try {
    runtime.pty.kill();
  } catch {
    // ignore kill failures
  }
}

function resolveCodexHomePath(): string {
  const raw = process.env.CODEX_HOME?.trim();
  const fallback = path.join(os.homedir(), '.codex');
  const expanded = (raw || fallback)
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME\b/g, os.homedir());
  return path.resolve(expanded);
}

function parseTimestampToMs(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return raw > 1e12 ? raw : raw * 1000;
  }

  if (typeof raw === 'string') {
    const asNum = Number(raw.trim());
    if (Number.isFinite(asNum)) {
      if (asNum > 1e12) return asNum;
      if (Number.isInteger(asNum) && asNum > 0 && asNum < 1e12 && asNum < 1e10) return asNum * 1000;
    }

    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function resolveSessionHistoryCandidates(sessionsDir: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const stack: string[] = [sessionsDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(next);
        out.push({ path: next, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, CLI_HISTORY_SCAN_FILE_LIMIT);
}

function getHistoryTokenCountPayloadTimestamp(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const candidates: unknown[] = [
    payload.timestamp,
    payload.time,
    payload.ts,
    isRecord(payload.payload) ? (payload.payload as Record<string, unknown>).timestamp : undefined,
    isRecord(payload.payload) ? (payload.payload as Record<string, unknown>).time : undefined,
    isRecord(payload.payload) ? (payload.payload as Record<string, unknown>).ts : undefined,
    isRecord(payload.payload) && isRecord((payload.payload as Record<string, unknown>).payload)
      ? (payload.payload as Record<string, unknown>).payload as unknown
      : undefined
  ];

  if (isRecord((payload as Record<string, unknown>).event)) {
    const eventPayload = (payload as Record<string, unknown>).event as Record<string, unknown>;
    candidates.push(eventPayload.timestamp, eventPayload.time, eventPayload.ts);
  }

  for (const candidate of candidates) {
    const ts = parseTimestampToMs(candidate);
    if (ts !== null) return ts;
  }
  return null;
}

function readLatestTokenCountFromSessionFile(filePath: string): CliHistoryStatusSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;

    const usage = getCliStatusUsageFromPayload(payload);
    const rateLimits = getCliStatusRateLimitsFromPayload(payload);
    if (!usage && !rateLimits) continue;

    return {
      usage: usage || null,
      rateLimits: rateLimits || null,
      sourcePath: filePath,
      timestampMs: getHistoryTokenCountPayloadTimestamp(payload) || Date.now()
    };
  }
  return null;
}

function getLatestTokenCountFromCodexHistory(): CliHistoryStatusSnapshot | null {
  if (cliHistorySnapshotCache && cliHistorySnapshotCache.expiresAt > Date.now()) {
    return cliHistorySnapshotCache.snapshot;
  }

  const sessionsDir = path.join(resolveCodexHomePath(), 'sessions');
  const files = resolveSessionHistoryCandidates(sessionsDir);
  let snapshot: CliHistoryStatusSnapshot | null = null;

  for (const file of files) {
    const fromFile = readLatestTokenCountFromSessionFile(file.path);
    if (!fromFile) continue;
    snapshot = fromFile;
    break;
  }

  cliHistorySnapshotCache = {
    expiresAt: Date.now() + CLI_HISTORY_CACHE_TTL_MS,
    snapshot
  };
  return snapshot;
}

function getCliStatusFallback(
  fallbackUsage: CliStatusUsageFallback = {}
): CliStatusUsageFallback {
  const localUsage = fallbackUsage.usage || null;
  const localRateLimits = fallbackUsage.rateLimits || null;
  const history = getLatestTokenCountFromCodexHistory();
  if (!history) {
    return { usage: localUsage, rateLimits: localRateLimits };
  }

  const mergedRateLimits = mergeRateLimitRecords(history.rateLimits, localRateLimits);
  return {
    usage: history.usage || localUsage,
    rateLimits: mergedRateLimits || null
  };
}

function getCliStatusUsageFromPayload(payload: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (!isRecord(payload)) return null;
  if (seen.has(payload)) return null;
  seen.add(payload);

  if (isRecord(payload.usage)) return payload.usage as Record<string, unknown>;

  // Common wrappers from MCP/http-like envelopes.
  if (isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).usage)) {
    return (payload.data as Record<string, unknown>).usage as Record<string, unknown>;
  }
  if (isRecord(payload.result) && isRecord((payload.result as Record<string, unknown>).usage)) {
    return (payload.result as Record<string, unknown>).usage as Record<string, unknown>;
  }
  if ((payload.type === 'token_count' || (payload.event as unknown) === 'token_count') && isRecord(payload.info)) {
    const fromTokenCount = extractTokenCountUsage(payload as Record<string, unknown>);
    if (fromTokenCount) return fromTokenCount;
  }
  if (isRecord((payload as Record<string, unknown>).payload) && isRecord((payload as Record<string, unknown>).payload)) {
    const nestedPayload = (payload as Record<string, unknown>).payload as Record<string, unknown>;
    if ((nestedPayload.type === 'token_count' || nestedPayload.event === 'token_count') && isRecord(nestedPayload.info)) {
      const fromNestedTokenCount = extractTokenCountUsage(nestedPayload);
      if (fromNestedTokenCount) return fromNestedTokenCount;
    }
  }

  // Try generic recursive search to support other payload shapes.
  for (const value of Object.values(payload)) {
    const found = getCliStatusUsageFromPayload(value, seen, depth + 1);
    if (found) return found;
  }

  return null;
}

function getCliStatusRateLimitsFromPayload(
  payload: unknown,
  seen = new Set<unknown>(),
  depth = 0
): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (!isRecord(payload)) return null;
  if (seen.has(payload)) return null;
  seen.add(payload);

  if (isRecord(payload.rateLimits)) {
    const normalized = normalizeRateLimitEnvelope(payload.rateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.rate_limits)) {
    const normalized = normalizeRateLimitEnvelope(payload.rate_limits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.usage) && isRecord((payload.usage as Record<string, unknown>).rateLimits)) {
    const usageRateLimits = (payload.usage as Record<string, unknown>).rateLimits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(usageRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.usage) && isRecord((payload.usage as Record<string, unknown>).rate_limits)) {
    const usageRateLimits = (payload.usage as Record<string, unknown>).rate_limits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(usageRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.meta) && isRecord((payload.meta as Record<string, unknown>).rateLimits)) {
    const metaRateLimits = (payload.meta as Record<string, unknown>).rateLimits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(metaRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.meta) && isRecord((payload.meta as Record<string, unknown>).rate_limits)) {
    const metaRateLimits = (payload.meta as Record<string, unknown>).rate_limits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(metaRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.info) && isRecord((payload.info as Record<string, unknown>).rateLimits)) {
    const infoRateLimits = (payload.info as Record<string, unknown>).rateLimits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(infoRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.info) && isRecord((payload.info as Record<string, unknown>).rate_limits)) {
    const infoRateLimits = (payload.info as Record<string, unknown>).rate_limits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(infoRateLimits);
    if (normalized) return normalized;
  }

  if (isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).rateLimits)) {
    const dataRateLimits = (payload.data as Record<string, unknown>).rateLimits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(dataRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).rate_limits)) {
    const dataRateLimits = (payload.data as Record<string, unknown>).rate_limits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(dataRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.result) && isRecord((payload.result as Record<string, unknown>).rateLimits)) {
    const resultRateLimits = (payload.result as Record<string, unknown>).rateLimits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(resultRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.result) && isRecord((payload.result as Record<string, unknown>).rate_limits)) {
    const resultRateLimits = (payload.result as Record<string, unknown>).rate_limits as Record<string, unknown>;
    const normalized = normalizeRateLimitEnvelope(resultRateLimits);
    if (normalized) return normalized;
  }
  if (isRecord(payload.payload)) {
    const asPayload = payload.payload as Record<string, unknown>;
    if (asPayload.type === 'token_count') {
      const fromPayloadRateLimits = normalizeRateLimitEnvelope(asPayload.rate_limits as unknown);
      if (fromPayloadRateLimits) return fromPayloadRateLimits;
      const fromPayloadCamelRateLimits = normalizeRateLimitEnvelope(asPayload.rateLimits as unknown);
      if (fromPayloadCamelRateLimits) return fromPayloadCamelRateLimits;
    }

      if (isRecord(asPayload.rateLimits)) {
        const normalizedPayloadRateLimits = normalizeRateLimitEnvelope(asPayload.rateLimits);
        if (normalizedPayloadRateLimits) return normalizedPayloadRateLimits;
      }
      if (isRecord(asPayload.rate_limits)) {
        const normalizedPayloadRateLimits2 = normalizeRateLimitEnvelope(asPayload.rate_limits);
        if (normalizedPayloadRateLimits2) return normalizedPayloadRateLimits2;
      }
  }
  const fromUsagePayload = extractRateLimitsFromOfficialUsagePayload(payload);
  if (fromUsagePayload) return fromUsagePayload;

  for (const value of Object.values(payload)) {
    const found = getCliStatusRateLimitsFromPayload(value, seen, depth + 1);
    if (found) return found;
  }

  return null;
}

function normalizeRateLimitId(v: unknown): string {
  if (typeof v !== 'string') return 'codex';
  const trimmed = v.trim();
  return trimmed || 'codex';
}

function normalizeRateLimitEnvelope(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  const directWindowFields = keys.some((k) =>
    k === 'primary' || k === 'secondary' || k === 'limit_id' || k === 'limitId' || k === 'limit_name' || k === 'limitName'
  );
  const childRecords = Object.values(raw).filter(isRecord);
  const nestedBucketValues = childRecords.some(
    (candidate) =>
      isRecord(candidate.primary) ||
      isRecord(candidate.secondary) ||
      candidate.limit_id ||
      candidate.limitId ||
      candidate.limit_name ||
      candidate.limitName
  );
  if (!directWindowFields && !nestedBucketValues) return null;

  if (directWindowFields) {
    const key = normalizeRateLimitId(raw.limit_id || raw.limitId || raw.limit_name || raw.limitName);
    return { [key.toLowerCase()]: raw };
  }
  return raw;
}

function extractTokenCountUsage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const info = isRecord(payload.info) ? payload.info : null;
  if (!info) return null;
  const usageSource = isRecord(info.total_token_usage)
    ? info.total_token_usage
    : isRecord(info.last_token_usage)
      ? info.last_token_usage
      : null;
  if (!usageSource) return null;

  const out = { ...usageSource };
  const contextWindow = normalizeNumeric((payload.model_context_window ?? info.model_context_window) as unknown);
  if (contextWindow !== null) {
    const used = normalizeNumeric(usageSource.total_tokens ?? usageSource.input_tokens);
    if (used !== null) {
      out.context_window = {
        total_tokens: contextWindow,
        used_tokens: used
      };
    } else {
      out.context_window = { total_tokens: contextWindow };
    }
  }
  return out;
}

function normalizeNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  return null;
}

function normalizeLimitName(value: unknown): string {
  if (typeof value !== 'string') return 'codex';
  const trimmed = value.trim();
  return trimmed || 'codex';
}

function windowMinutesFromSeconds(seconds: unknown): number | null {
  const sec = normalizeNumeric(seconds);
  if (!sec || sec <= 0) return null;
  return Math.floor((sec + 59) / 60);
}

function parseWindowMinutesFromLabel(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|minutes?|h|hr|hrs|hours?|d|day|days?|w|week|weeks?)$/i);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('s')) return Math.max(1, Math.ceil(n / 60));
  if (unit.startsWith('m')) return Math.ceil(n);
  if (unit.startsWith('h')) return Math.ceil(n * 60);
  if (unit.startsWith('d')) return Math.ceil(n * 24 * 60);
  if (unit.startsWith('w')) return Math.ceil(n * 7 * 24 * 60);
  return null;
}

function normalizeResetAt(value: unknown): number | null {
  const raw = normalizeNumeric(value);
  if (raw === null) return null;
  if (!Number.isFinite(raw)) return null;
  if (raw > 0 && raw <= 10_000_000_000) {
    const absThreshold = Date.now() / 1000 + 5 * 24 * 3600;
    if (raw > absThreshold) {
      return raw * 1000;
    }
    return Date.now() + raw * 1000;
  }
  return raw;
}

function normalizeRateLimitWindow(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;

  let usedPercent = normalizeNumeric(
    raw.used_percent ??
      raw.usedPercent ??
      (raw as Record<string, unknown>).percent_used ??
      (raw as Record<string, unknown>).percentUsed
  );
  if (usedPercent === null) {
    const remainingPercent = normalizeNumeric(
      (raw as Record<string, unknown>).remaining_percent ??
      (raw as Record<string, unknown>).remainingPercent ??
      (raw as Record<string, unknown>).percent_remaining ??
      (raw as Record<string, unknown>).percentRemaining ??
      (raw as Record<string, unknown>).left_percent ??
      (raw as Record<string, unknown>).leftPercent
    );
    if (remainingPercent !== null) {
      usedPercent = 100 - remainingPercent;
    }
  }
  if (usedPercent === null) {
    const used = normalizeNumeric(
      raw.used ??
        raw.usedAmount ??
        raw.current ??
        (raw as Record<string, unknown>).total_used ??
        (raw as Record<string, unknown>).tokens_used ??
        (raw as Record<string, unknown>).usedTokens
    );
    const limit = normalizeNumeric(
      raw.limit ??
        raw.limitAmount ??
        raw.max ??
        raw.max_tokens ??
        (raw as Record<string, unknown>).capacity ??
        (raw as Record<string, unknown>).total_limit ??
        (raw as Record<string, unknown>).totalLimit ??
        (raw as Record<string, unknown>).limitTokens ??
        (raw as Record<string, unknown>).maxTokens ??
        (raw as Record<string, unknown>).capacity_tokens ??
        (raw as Record<string, unknown>).capacityTokens
    );
    if (used !== null && limit !== null && limit > 0) {
      usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
    }
  }
  if (usedPercent === null) return null;

  const windowMinutes = normalizeNumeric(raw.window_minutes)
    ?? normalizeNumeric((raw as Record<string, unknown>).windowMinutes)
    ?? parseWindowMinutesFromLabel((raw as Record<string, unknown>).window)
    ?? parseWindowMinutesFromLabel((raw as Record<string, unknown>).windowLabel)
    ?? parseWindowMinutesFromLabel((raw as Record<string, unknown>).window_name)
    ?? windowMinutesFromSeconds((raw as Record<string, unknown>).limit_window_seconds)
    ?? windowMinutesFromSeconds((raw as Record<string, unknown>).window_seconds);

  const resetsAt = normalizeResetAt(
    (raw as Record<string, unknown>).resets_at ??
      (raw as Record<string, unknown>).resetsAt ??
      (raw as Record<string, unknown>).reset_at ??
      (raw as Record<string, unknown>).resetAt ??
      (raw as Record<string, unknown>).reset_in ??
      (raw as Record<string, unknown>).resetsIn ??
      (raw as Record<string, unknown>).resetIn ??
      (raw as Record<string, unknown>).reset_in_ms
  );

  const out: Record<string, unknown> = { used_percent: usedPercent };
  if (windowMinutes !== null) out.window_minutes = windowMinutes;
  if (resetsAt !== null) out.resets_at = resetsAt;
  return out;
}

function normalizeRateLimitCredits(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const hasCredits = normalizeBoolean(raw.has_credits);
  const unlimited = normalizeBoolean(raw.unlimited);
  if (hasCredits === null || unlimited === null) return null;

  const balance = raw.balance;
  const out: Record<string, unknown> = {
    has_credits: hasCredits,
    unlimited
  };
  if (typeof balance !== 'undefined') out.balance = balance;
  return out;
}

function extractRateLimitsFromOfficialUsagePayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (!isRecord((payload as Record<string, unknown>).rate_limit) && !isRecord((payload as Record<string, unknown>).rateLimit) && !Array.isArray((payload as Record<string, unknown>).additional_rate_limits)) {
    return null;
  }

  const out: Record<string, unknown> = {};

  const primary = (payload as Record<string, unknown>).rate_limit ?? (payload as Record<string, unknown>).rateLimit;
  if (isRecord(primary)) {
    const limitName = normalizeLimitName((payload as Record<string, unknown>).limit_name ?? (payload as Record<string, unknown>).limitName);
    const snapshot: Record<string, unknown> = {
      limit_id: 'codex',
      limit_name: limitName || 'codex'
    };
    const primaryWindow = normalizeRateLimitWindow(primary.primary_window ?? (primary as Record<string, unknown>).primaryWindow);
    const secondaryWindow = normalizeRateLimitWindow(primary.secondary_window ?? (primary as Record<string, unknown>).secondaryWindow);
    if (primaryWindow) snapshot.primary = primaryWindow;
    if (secondaryWindow) snapshot.secondary = secondaryWindow;

    const credits = normalizeRateLimitCredits(primary.credits);
    if (credits) snapshot.credits = credits;
    out.codex = snapshot;
  }

  const additional = (payload as Record<string, unknown>).additional_rate_limits ?? (payload as Record<string, unknown>).additionalRateLimits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      if (!isRecord(item)) continue;
      const itemName = normalizeLimitName(item.limit_name ?? item.metered_feature ?? item.limitName);
      const mappedName = itemName || 'codex';
      const rateLimit = item.rate_limit ?? item.rateLimit;
      if (!isRecord(rateLimit)) continue;

      const snapshot: Record<string, unknown> = {
        limit_id: mappedName.toLowerCase(),
        limit_name: itemName
      };
      const primaryWindow = normalizeRateLimitWindow(rateLimit.primary_window ?? (rateLimit as Record<string, unknown>).primaryWindow);
      const secondaryWindow = normalizeRateLimitWindow(rateLimit.secondary_window ?? (rateLimit as Record<string, unknown>).secondaryWindow);
      if (primaryWindow) snapshot.primary = primaryWindow;
      if (secondaryWindow) snapshot.secondary = secondaryWindow;
      const credits = normalizeRateLimitCredits(rateLimit.credits);
      if (credits) snapshot.credits = credits;
      out[mappedName] = snapshot;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function mergeRateLimitRecords(base: Record<string, unknown> | null, incoming: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!base) return incoming ? { ...incoming } : null;
  if (!incoming) return { ...base };

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) {
      out[key] = mergeRateLimitRecords(current, value) as Record<string, unknown>;
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function collectRuntimeUsageAndRateLimits(): Promise<{
  usage: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
}> {
  const sessions = store.getAllSessions();
  let usage: Record<string, unknown> | null = null;
  let rateLimits: Record<string, unknown> | null = null;

  for (const session of sessions) {
    const chats = store.listChats(session.id);
    const usageAndLimits = await Promise.all(
      chats.map(async (chat) => {
        const [chatUsage, chatRateLimits] = await Promise.all([
          codex.getChatUsage(session.id, chat.id),
          codex.getChatRateLimits(session.id, chat.id)
        ]);
        return { chatUsage, chatRateLimits };
      })
    );

    for (const item of usageAndLimits) {
      if (item.chatUsage) usage = usage ? mergeUsageRecords(usage, item.chatUsage) : { ...item.chatUsage };
      if (item.chatRateLimits) rateLimits = mergeRateLimitRecords(rateLimits, item.chatRateLimits);
    }
  }

  return { usage, rateLimits };
}

function resolveCliStatusUrl(): string {
  if (env.CODEX_CLI_STATUS_URL) return env.CODEX_CLI_STATUS_URL;
  return `http://127.0.0.1:${env.PORT}/api/cli-status`;
}

function mergeUsageValues(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (typeof left === 'string' && typeof right === 'string') {
    const l = Number(left);
    const r = Number(right);
    if (Number.isFinite(l) && Number.isFinite(r)) return `${l + r}`;
  }
  if (isRecord(left) && isRecord(right)) return mergeUsageRecords(left, right);
  return right;
}

function mergeUsageRecords(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, rawValue] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = rawValue;
      continue;
    }
    out[key] = mergeUsageValues(out[key], rawValue);
  }
  return out;
}

type CliStatusUsageFallback = {
  usage?: Record<string, unknown> | null;
  rateLimits?: Record<string, unknown> | null;
};

async function getCliStatusUsage(fallbackUsage: CliStatusUsageFallback = {}): Promise<CliStatusUsageResult> {
  const statusUrl = resolveCliStatusUrl();
  const fallbackCombined = getCliStatusFallback(fallbackUsage);
  if (!statusUrl) {
    if (fallbackCombined.usage || fallbackCombined.rateLimits) {
      return { usage: fallbackCombined.usage, rateLimits: fallbackCombined.rateLimits };
    }
    return { usage: null, error: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const r = await fetch(statusUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!r.ok) {
      return {
        usage: fallbackCombined.usage,
        rateLimits: fallbackCombined.rateLimits,
        error: fallbackCombined.usage || fallbackCombined.rateLimits ? `http_${r.status}_with_fallback` : `http_${r.status}`
      };
    }
    const body = await r.json().catch(() => null);
    if (!body) {
      return {
        usage: fallbackCombined.usage,
        rateLimits: fallbackCombined.rateLimits,
        error: fallbackCombined.usage || fallbackCombined.rateLimits ? 'invalid_json_with_fallback' : 'invalid_json'
      };
    }
    const usage = getCliStatusUsageFromPayload(body);
    const rateLimits = getCliStatusRateLimitsFromPayload(body);
    if (usage || rateLimits) {
      const mergedRateLimits = mergeRateLimitRecords(rateLimits, fallbackCombined.rateLimits);
      return {
        usage: usage || fallbackCombined.usage || null,
        rateLimits: mergedRateLimits || null
      };
    }
    return {
      usage: fallbackCombined.usage,
      rateLimits: fallbackCombined.rateLimits,
      error: fallbackCombined.usage || fallbackCombined.rateLimits ? 'usage_not_found_with_fallback' : 'usage_not_found'
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return {
        usage: fallbackCombined.usage,
        rateLimits: fallbackCombined.rateLimits,
        error: fallbackCombined.usage || fallbackCombined.rateLimits ? 'request_timeout_with_fallback' : 'request_timeout'
      };
    }
    return {
      usage: fallbackCombined.usage,
      rateLimits: fallbackCombined.rateLimits,
      error: fallbackCombined.usage || fallbackCombined.rateLimits ? 'request_failed_with_fallback' : 'request_failed'
    };
  } finally {
    clearTimeout(timer);
  }
}

function getCodexLoginStatusText(): string | null {
  try {
    const run = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      timeout: 1200
    });
    const out = `${run.stdout || ''}${run.stderr || ''}`.trim();
    if (!out) return null;
    const firstLine = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return firstLine || null;
  } catch {
    return null;
  }
}

function parseReasoningEffort(v: unknown): ReasoningEffort | null {
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') return v;
  return null;
}

function uniqueReasoningEfforts(items: ReasoningEffort[]): ReasoningEffort[] {
  return Array.from(new Set(items));
}

function readCodexModelOptions(): CodexModelOption[] {
  const codexHome = (process.env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
  const cachePath = path.join(codexHome, 'models_cache.json');
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) return [];

    const out: CodexModelOption[] = [];
    for (const item of parsed.models) {
      if (!isRecord(item)) continue;
      if (typeof item.visibility === 'string' && item.visibility !== 'list') continue;
      const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
      if (!slug) continue;

      const displayName = typeof item.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : slug;
      const description = typeof item.description === 'string' && item.description.trim()
        ? item.description.trim()
        : undefined;
      const defaultReasoningEffort = parseReasoningEffort(item.default_reasoning_level);

      const reasoningEfforts = uniqueReasoningEfforts(
        Array.isArray(item.supported_reasoning_levels)
          ? item.supported_reasoning_levels
            .map((x) => (isRecord(x) ? parseReasoningEffort(x.effort) : null))
            .filter((x): x is ReasoningEffort => Boolean(x))
          : []
      );

      if (!reasoningEfforts.length && defaultReasoningEffort) {
        reasoningEfforts.push(defaultReasoningEffort);
      }

      out.push({
        slug,
        displayName,
        description,
        defaultReasoningEffort: defaultReasoningEffort || undefined,
        reasoningEfforts
      });
    }
    return out;
  } catch {
    return [];
  }
}

const codexModelOptions = readCodexModelOptions();
if (!codexModelOptions.length && env.CODEX_MODEL) {
  const fallbackEffort = parseReasoningEffort(env.CODEX_REASONING_EFFORT);
  codexModelOptions.push({
    slug: env.CODEX_MODEL,
    displayName: env.CODEX_MODEL,
    defaultReasoningEffort: fallbackEffort || undefined,
    reasoningEfforts: fallbackEffort ? [fallbackEffort] : []
  });
}

const codexReasoningEffortOptions = uniqueReasoningEfforts(
  codexModelOptions.flatMap((m) => m.reasoningEfforts)
);

// TOTP provisioning lock: once a user successfully logs in via TOTP, we write a marker file.
// After that, QR/URI should not be retrievable or printed again.
const totpProvisionPath = path.isAbsolute(env.TOTP_PROVISION_FILE)
  ? env.TOTP_PROVISION_FILE
  : path.resolve(serverRootDir, env.TOTP_PROVISION_FILE);

function isTotpProvisioned(): boolean {
  try {
    return fs.existsSync(totpProvisionPath);
  } catch {
    return false;
  }
}

function markTotpProvisioned(): void {
  try {
    fs.writeFileSync(
      totpProvisionPath,
      JSON.stringify({ provisionedAt: Date.now() }, null, 2) + '\n',
      { flag: 'wx' }
    );
  } catch (e: any) {
    // Ignore if already exists.
    if (e?.code !== 'EEXIST') throw e;
  }
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(env.SESSION_SECRET));

if (env.WEB_ORIGIN) {
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true
    })
  );
}

function getSessionId(req: express.Request): string | null {
  const sid = (req.signedCookies?.sid as string | undefined) || (req.cookies?.sid as string | undefined);
  if (!sid) return null;
  const s = store.getSession(sid);
  if (!s) return null;
  store.refreshSession(sid);
  return s.id;
}

function setSessionCookie(res: express.Response, sid: string, maxAgeMs: number = env.SESSION_TTL_MS) {
  res.cookie('sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: false, // set true behind HTTPS
    maxAge: maxAgeMs
  });
}

function requireAuth(req: express.Request, res: express.Response): string | null {
  const sid = getSessionId(req);
  if (!sid) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return sid;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.get('/api/auth/mode', (_req, res) => {
  res.json({ ok: true, mode: 'totp' });
});

app.get('/api/auth/totp/status', (_req, res) => {
  return res.json({ ok: true, enabled: Boolean(env.TOTP_SECRET), provisioned: isTotpProvisioned() });
});

app.get('/api/auth/totp/uri', (_req, res) => {
  if (!env.TOTP_SECRET) {
    return res.status(500).json({ ok: false, error: 'totp_not_configured' });
  }
  if (isTotpProvisioned()) {
    // Global one-time QR: once someone successfully logged in, do not allow retrieving URI again.
    return res.status(404).json({ ok: false, error: 'provisioned' });
  }

  const uri = authenticator.keyuri(env.TOTP_ACCOUNT, env.TOTP_ISSUER, env.TOTP_SECRET);
  res.json({ ok: true, uri });
});

const CreateCredentialSchema = z.object({
  label: z.string().trim().max(80).optional()
});

const CredentialLoginSchema = z.object({
  credential: z.string().trim().min(8)
});

const RevokeCredentialSchema = z.object({
  credentialId: z.string().min(1)
});

app.get('/api/me', (req, res) => {
  const sid = getSessionId(req);
  // Returning 401 here creates a noisy console error on the login screen.
  // Keep /api/me as a "soft auth" probe (200 + ok:false) and reserve 401s for protected endpoints.
  if (!sid) return res.json({ ok: false });
  const session = store.getSession(sid);
  if (!session) return res.json({ ok: false });
  const expiresInMs = env.SESSION_TTL_MS;
  res.json({
    ok: true,
    sessionId: sid,
    activeChatId: store.getActiveChatId(sid) || undefined,
    expiresInMs
  });
});

app.get('/api/status', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const session = store.getSession(sid);
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });

  const localUsageAgg = await collectRuntimeUsageAndRateLimits();

  const chats = store.listChats(sid);
  const runtimeByChat = await Promise.all(
    chats.map(async (c) => {
      const [rt, usage, sessionState] = await Promise.all([
        reconcileRuntimeStatus(sid, c.id),
        codex.getChatUsage(sid, c.id),
        codex.getChatSessionState(sid, c.id).catch(() => null)
      ]);
      return {
        id: c.id,
        status: rt.status,
        updatedAt: c.updatedAt,
        usage: usage || undefined,
        codexSessionId: sessionState?.sessionId || undefined
      };
    })
  );
  const runningCount = runtimeByChat.filter((x) => x.status === 'running').length;
  const localUsage = localUsageAgg.usage || undefined;
  const cliStatusUsage = await getCliStatusUsage(localUsageAgg);
  const activeChatId = session.activeChatId || null;
  const activeRuntime = activeChatId ? runtimeByChat.find((item) => item.id === activeChatId) : null;
  const accountStatus = getCodexLoginStatusText();

  res.json({
    ok: true,
    time: Date.now(),
    usage: localUsage,
    cliUsage: cliStatusUsage.usage || undefined,
    cliRateLimits: cliStatusUsage.rateLimits || undefined,
    cliUsageError: cliStatusUsage.error,
    accountStatus: accountStatus || undefined,
    collaborationMode: 'Default',
    defaults: {
      model: env.CODEX_MODEL || null,
      reasoningEffort: env.CODEX_REASONING_EFFORT || null,
      cwd: env.CODEX_CWD,
      sandbox: env.CODEX_SANDBOX,
      approvalPolicy: env.CODEX_APPROVAL_POLICY
    },
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      activeChatId,
      codexSessionId: activeRuntime?.codexSessionId || null
    },
    chats: {
      total: chats.length,
      running: runningCount,
      items: runtimeByChat
    }
  });
});

app.get('/api/cli-status', async (_req, res) => {
  const sessions = store.getAllSessions();
  let globalUsage: Record<string, unknown> | null = null;
  let globalRateLimits: Record<string, unknown> | null = null;

  const sessionItems = await Promise.all(sessions.map(async (session) => {
    const activeChatId = store.getActiveChatId(session.id);
    const chats = store.listChats(session.id);
    let sessionUsage: Record<string, unknown> | null = null;
    let sessionRateLimits: Record<string, unknown> | null = null;
    let lastRuntimeAt = 0;

    for (const c of chats) {
      const [runtime, usage, rateLimits] = await Promise.all([
        reconcileRuntimeStatus(session.id, c.id),
        codex.getChatUsage(session.id, c.id),
        codex.getChatRateLimits(session.id, c.id)
      ]);
      if (usage) {
        sessionUsage = sessionUsage ? mergeUsageRecords(sessionUsage, usage) : { ...usage };
      }
      if (rateLimits) {
        sessionRateLimits = mergeRateLimitRecords(sessionRateLimits, rateLimits);
      }
      if (runtime.updatedAt > lastRuntimeAt) {
        lastRuntimeAt = runtime.updatedAt;
      }
    }

    if (sessionUsage) {
      globalUsage = globalUsage ? mergeUsageRecords(globalUsage, sessionUsage) : { ...sessionUsage };
    }
    if (sessionRateLimits) {
      globalRateLimits = mergeRateLimitRecords(globalRateLimits, sessionRateLimits);
    }

    return {
      sessionId: session.id,
      activeChatId,
      chatCount: store.listChats(session.id).length,
      running: chats.some((chat) => store.getStreamRuntime(session.id, chat.id).status === 'running'),
      updatedAt: lastRuntimeAt,
      usage: sessionUsage || null,
      rateLimits: sessionRateLimits || null
    };
  }));

  const fallback = getCliStatusFallback({ usage: globalUsage, rateLimits: globalRateLimits });

  res.json({
    time: Date.now(),
    usage: fallback.usage || undefined,
    rateLimits: fallback.rateLimits || undefined,
    sessions: sessionItems
  });
});

app.get('/api/defaults', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  res.json({
    ok: true,
    defaults: {
      model: env.CODEX_MODEL || null,
      reasoningEffort: env.CODEX_REASONING_EFFORT || null,
      cwd: env.CODEX_CWD,
      sandbox: env.CODEX_SANDBOX,
      approvalPolicy: env.CODEX_APPROVAL_POLICY,
      modelOptions: codexModelOptions,
      reasoningEffortOptions: codexReasoningEffortOptions
    }
  });
});

function expandUserPath(p: string): string {
  const home = os.homedir();
  return p
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home);
}

const chatWorkspaceBaseDir = (() => {
  const raw = env.CHAT_WORKSPACES_DIR?.trim();
  const fallback = path.join(env.CODEX_CWD, '.codex-remoteapp', 'chats');
  const candidate = raw ? expandUserPath(raw) : fallback;
  const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(env.CODEX_CWD, candidate);
  if (env.CHAT_CWD_MODE === 'isolated') {
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'mkdir_failed';
      console.warn(`[server] chat workspace root unavailable (${abs}): ${msg}`);
    }
  }
  return abs;
})();

function toSafePathSegment(input: string, fallback: string): string {
  const safe = input
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return safe || fallback;
}

function getIsolatedChatCwd(sessionId: string, chatId: string): string {
  const sid = toSafePathSegment(sessionId, 'sid').slice(0, 24);
  const cid = toSafePathSegment(chatId, 'chat');
  return path.join(chatWorkspaceBaseDir, sid, cid);
}

function ensureChatWorkingDirectory(
  sessionId: string,
  chat: { id: string; settings?: { cwd?: string } }
): string {
  const explicit = typeof chat.settings?.cwd === 'string' ? chat.settings.cwd.trim() : '';
  if (explicit) return explicit;
  if (env.CHAT_CWD_MODE !== 'isolated') return env.CODEX_CWD;

  const target = getIsolatedChatCwd(sessionId, chat.id);
  try {
    fs.mkdirSync(target, { recursive: true });
    store.updateChatSettings(sessionId, chat.id, { cwd: target });
    return target;
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : 'set_cwd_failed';
    console.warn(`[server] failed to provision chat cwd for ${sessionId}:${chat.id}: ${msg}`);
    return env.CODEX_CWD;
  }
}

function backfillChatWorkingDirectories(): void {
  if (env.CHAT_CWD_MODE !== 'isolated') return;
  let assigned = 0;
  for (const session of store.getAllSessions()) {
    for (const item of store.listChats(session.id)) {
      const chat = store.getChat(session.id, item.id);
      if (!chat) continue;
      const had = typeof chat.settings?.cwd === 'string' && chat.settings.cwd.trim().length > 0;
      if (had) continue;
      const cwd = ensureChatWorkingDirectory(session.id, chat);
      if (cwd !== env.CODEX_CWD) assigned += 1;
    }
  }
  if (assigned > 0) {
    console.log(`[server] Chat isolation: assigned dedicated cwd for ${assigned} chat(s) under ${chatWorkspaceBaseDir}`);
  }
}

function computeCwdRoots(): { abs: string; real: string; label: string }[] {
  const configured = env.CWD_ROOTS ? env.CWD_ROOTS.split(',').map((s) => s.trim()).filter(Boolean) : [env.CODEX_CWD];
  const raw = env.CHAT_CWD_MODE === 'isolated' ? [...configured, chatWorkspaceBaseDir] : configured;
  const deduped = Array.from(new Set(raw));
  const abs = deduped.map((p) => {
    const x = expandUserPath(p);
    return path.isAbsolute(x) ? x : path.resolve(x);
  });

  const out: { abs: string; real: string; label: string }[] = [];
  for (const p of abs) {
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      const real = fs.realpathSync(p);
      const label = p === env.CODEX_CWD ? 'Default' : p === chatWorkspaceBaseDir ? 'Chats' : path.basename(p) || p;
      out.push({ abs: p, real, label });
    } catch {
      // ignore invalid roots
    }
  }
  // Always ensure at least CODEX_CWD exists as a root if possible.
  if (!out.length) {
    try {
      const real = fs.realpathSync(env.CODEX_CWD);
      out.push({ abs: env.CODEX_CWD, real, label: 'Default' });
    } catch {
      // nothing
    }
  }
  return out;
}

const cwdRoots = computeCwdRoots();
backfillChatWorkingDirectories();

function isWithinRoot(real: string, rootReal: string): boolean {
  if (real === rootReal) return true;
  const pref = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return real.startsWith(pref);
}

function resolveAllowedDir(p: string): { ok: true; real: string } | { ok: false; error: string } {
  try {
    const expanded = expandUserPath(p);
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(env.CODEX_CWD, expanded);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { ok: false, error: 'not_dir' };
    const real = fs.realpathSync(abs);
    const ok = cwdRoots.some((r) => isWithinRoot(real, r.real));
    if (!ok) return { ok: false, error: 'outside_root' };
    return { ok: true, real };
  } catch {
    return { ok: false, error: 'not_found' };
  }
}

app.get('/api/fs/roots', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  res.json({ ok: true, roots: cwdRoots.map((r) => ({ path: r.abs, label: r.label })) });
});

app.get('/api/fs/ls', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const p = typeof req.query.path === 'string' ? req.query.path : '';
  const showHidden = req.query.hidden === '1';

  const dir = p || env.CODEX_CWD;
  const resolved = resolveAllowedDir(dir);
  if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

  const entries = fs.readdirSync(resolved.real, { withFileTypes: true })
    .filter((d) => (showHidden ? true : !d.name.startsWith('.')))
    .map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
  });

  res.json({ ok: true, path: resolved.real, entries });
});

app.post('/api/fs/mkdir', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;

  const parsed = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  const requested = parsed.data.path.trim();
  if (!requested) return res.status(400).json({ ok: false, error: 'bad_request' });
  if (requested.includes('\u0000')) return res.status(400).json({ ok: false, error: 'bad_name' });

  const abs = expandUserPath(path.isAbsolute(requested) ? requested : path.resolve(env.CODEX_CWD, requested));
  const parent = path.dirname(abs);
  const name = path.basename(abs);

  if (!name || name === '.' || name === '..') {
    return res.status(400).json({ ok: false, error: 'bad_name' });
  }
  if (path.isAbsolute(requested) && !path.resolve(abs).startsWith(path.resolve(parent))) {
    return res.status(400).json({ ok: false, error: 'bad_name' });
  }

  const parentResolved = resolveAllowedDir(parent);
  if (!parentResolved.ok) return res.status(400).json({ ok: false, error: parentResolved.error });

  const target = path.resolve(parentResolved.real, name);
  try {
    fs.mkdirSync(target, { recursive: false });
    return res.json({ ok: true, path: target });
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      return res.status(409).json({ ok: false, error: 'already_exists' });
    }
    if (e?.code === 'ENOTDIR' || e?.code === 'ENOENT') {
      return res.status(400).json({ ok: false, error: 'invalid_parent' });
    }
    return res.status(500).json({ ok: false, error: 'mkdir_failed' });
  }
});

const TotpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/)
});

app.post('/api/auth/totp/verify', (req, res) => {
  if (!env.TOTP_SECRET) {
    return res.status(500).json({ ok: false, error: 'totp_not_configured' });
  }

  const parsed = TotpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  authenticator.options = { window: 2 };
  const ok = authenticator.check(parsed.data.code, env.TOTP_SECRET);
  if (!ok) {
    return res.status(401).json({ ok: false, error: 'invalid' });
  }

  // First successful TOTP login permanently disables QR/URI for this server instance (and across restarts).
  markTotpProvisioned();

  // All devices that scan the same QR share a single logical "account session".
  // Cookie is signed, so clients can't forge other ids.
  const fixedSid = (() => {
    const raw = `${env.SESSION_SECRET}:${env.TOTP_SECRET}:${env.TOTP_ISSUER}:${env.TOTP_ACCOUNT}`;
    const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
    return `totp_${h}`;
  })();
  const session = store.getOrCreateSessionWithId(fixedSid);
  setSessionCookie(res, session.id, env.SESSION_TTL_MS);
  res.json({ ok: true, sessionId: session.id, expiresInMs: env.SESSION_TTL_MS });
});

const createCredentialHandler = (_req: express.Request, res: express.Response) => {
  res.status(404).json({ ok: false, error: 'disabled' });
};

const credentialLoginHandler = (_req: express.Request, res: express.Response) => {
  res.status(404).json({ ok: false, error: 'disabled' });
};

const listCredentialsHandler = (_req: express.Request, res: express.Response) => {
  res.status(404).json({ ok: false, error: 'disabled' });
};

const revokeCredentialHandler = (_req: express.Request, res: express.Response) => {
  res.status(404).json({ ok: false, error: 'disabled' });
};

app.post('/api/auth/credential', createCredentialHandler);
app.post('/codex/api/auth/credential', createCredentialHandler);
app.post('/api/auth/credential/login', credentialLoginHandler);
app.post('/codex/api/auth/credential/login', credentialLoginHandler);
app.get('/api/auth/credentials', listCredentialsHandler);
app.get('/codex/api/auth/credentials', listCredentialsHandler);
app.post('/api/auth/credential/revoke', revokeCredentialHandler);
app.post('/codex/api/auth/credential/revoke', revokeCredentialHandler);

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.post('/api/chats', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chat = store.createChat(sid);
  const cwd = ensureChatWorkingDirectory(sid, chat);
  res.json({ ok: true, chatId: chat.id, cwd });
});

const terminalRouteSchema = z.object({
  cwd: z.string().min(1).optional()
});

const createTerminalHandler = (req: express.Request, res: express.Response) => {
  const sid = requireAuth(req, res);
  if (!sid) return;

  const parsed = terminalRouteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  const cwdInput = parsed.data.cwd || env.CODEX_CWD;
  const resolved = resolveAllowedDir(cwdInput);
  if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

  let terminal: TerminalSessionRecord;
  try {
    terminal = createTerminalRuntime(sid, resolved.real);
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : 'terminal_spawn_failed';
    console.error(`[terminal] failed to spawn shell: ${msg}`);
    return res.status(500).json({ ok: false, error: 'terminal_spawn_failed' });
  }
  res.json({
    ok: true,
    terminal: {
      terminalId: terminal.id,
      cwd: terminal.cwd,
      createdAt: terminal.createdAt
    }
  });
};

const listTerminalsHandler = (req: express.Request, res: express.Response) => {
  const sid = requireAuth(req, res);
  if (!sid) return;

  const list = store.listTerminalSessions(sid);
  res.json({
    ok: true,
    terminals: list.map((terminal) => ({
      terminalId: terminal.id,
      cwd: terminal.cwd,
      createdAt: terminal.createdAt,
      status: terminal.status
    }))
  });
};

app.post('/api/terminal', createTerminalHandler);
app.post('/codex/api/terminal', createTerminalHandler);
app.get('/api/terminals', listTerminalsHandler);
app.get('/codex/api/terminals', listTerminalsHandler);

app.get('/api/chats', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  res.json({ ok: true, chats: store.listChats(sid) });
});

app.get('/api/chats/:chatId', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chat = store.getChat(sid, req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });
  store.setActiveChatId(sid, req.params.chatId);

  const totalMessages = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const rawTail = typeof req.query.tail === 'string' ? Number(req.query.tail) : NaN;
  const tail = Number.isFinite(rawTail) ? Math.max(0, Math.min(1000, Math.floor(rawTail))) : 0;
  const start = tail > 0 ? Math.max(0, totalMessages - tail) : 0;
  const messages = tail > 0 ? chat.messages.slice(start) : chat.messages;

  const safeSettings = { ...(chat.settings as Record<string, unknown>) };
  delete safeSettings.sandbox;
  delete safeSettings.approvalPolicy;

  res.json({
    ok: true,
    chat: {
      ...chat,
      messages,
      messagesStart: start,
      messagesTotal: totalMessages,
      settings: safeSettings
    }
  });
});

app.delete('/api/chats/:chatId', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chatId = req.params.chatId;

  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  await codex.abort(sid, chatId).catch(() => undefined);
  await codex.reset(sid, chatId).catch(() => undefined);
  const ok = store.deleteChat(sid, chatId);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/chats/:chatId/runtime', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chat = store.getChat(sid, req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });
  const rt = await reconcileRuntimeStatus(sid, req.params.chatId);
  res.json({ ok: true, status: rt.status, lastEventId: rt.lastEventId, updatedAt: rt.updatedAt });
});

function writeSseEvent(res: express.Response, e: StreamEvent) {
  res.write(`id: ${e.id}\n`);
  res.write(`event: ${e.event}\n`);
  res.write(`data: ${JSON.stringify(e.data)}\n\n`);
}

async function syncStreamFromSessiond(sid: string, chatId: string): Promise<void> {
  let remoteRt;
  try {
    remoteRt = await codex.getRuntime(sid, chatId);
  } catch {
    return;
  }

  let after = codex.getKnownCursor(sid, chatId);
  if (after > remoteRt.lastEventId) {
    after = 0;
    codex.resetKnownCursor(sid, chatId);
  }

  const localRt = store.getStreamRuntime(sid, chatId);
  const rebuildFromScratch = after === 0 && localRt.lastEventId === 0 && remoteRt.lastEventId > 0;
  if (rebuildFromScratch) {
    store.resetStream(sid, chatId);
  }

  const events = await codex.listEventsSince(sid, chatId, after);
  let shouldResetAssistantText = rebuildFromScratch;
  for (const e of events) {
    codex.markKnownCursor(sid, chatId, e.id);
    if (e.event === 'start') {
      store.appendStreamEvent(sid, chatId, 'start', e.data);
      const assistantMessageId =
        typeof e.data?.assistantMessageId === 'string' ? e.data.assistantMessageId : '';
      if (shouldResetAssistantText && assistantMessageId) {
        try {
          store.setMessageText(sid, chatId, assistantMessageId, '');
        } catch {
          // ignore missing message during partial recovery
        }
      }
      shouldResetAssistantText = false;
      continue;
    }

    if (e.event === 'delta') {
      const assistantMessageId =
        typeof e.data?.assistantMessageId === 'string' ? e.data.assistantMessageId : '';
      const text = typeof e.data?.text === 'string' ? e.data.text : '';
      if (assistantMessageId && text) {
        try {
          store.appendToMessageText(sid, chatId, assistantMessageId, text);
        } catch {
          // ignore missing message during partial recovery
        }
      }
      store.appendStreamEvent(sid, chatId, 'delta', { text, assistantMessageId: assistantMessageId || null });
      continue;
    }

    if (
      e.event === 'approval_request' ||
      e.event === 'progress' ||
      e.event === 'codex_event' ||
      e.event === 'codex_usage' ||
      e.event === 'codex_rate_limits' ||
      e.event === 'turn_error' ||
      e.event === 'done'
    ) {
      store.appendStreamEvent(sid, chatId, e.event, e.data);
      continue;
    }
  }
}

async function reconcileRuntimeStatus(
  sid: string,
  chatId: string
): Promise<{ status: 'idle' | 'running' | 'done' | 'error'; lastEventId: number; updatedAt: number }> {
  const k = `${sid}:${chatId}`;
  if (!localTurnPumps.has(k)) {
    await syncStreamFromSessiond(sid, chatId);
  }

  const rt = store.getStreamRuntime(sid, chatId);
  if (rt.status === 'running') {
    if (!localTurnPumps.has(k)) {
      const busy = await codex.isBusy(sid, chatId).catch(() => true);
      if (!busy) {
        store.appendStreamEvent(sid, chatId, 'done', { ok: true, reconciled: true });
        return store.getStreamRuntime(sid, chatId);
      }
    }
  }
  return rt;
}

app.get('/api/chats/:chatId/stream', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  const afterParam = req.query.after ? Number(req.query.after) : undefined;
  const lastEventIdHeader = req.header('last-event-id') ?? req.header('Last-Event-ID');
  const afterHeader = lastEventIdHeader ? Number(lastEventIdHeader) : undefined;
  // Prefer Last-Event-ID so EventSource reconnect works even if caller uses a static `after=` query param.
  const after = Number.isFinite(afterHeader) ? (afterHeader as number) : (Number.isFinite(afterParam) ? (afterParam as number) : 0);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const rt = await reconcileRuntimeStatus(sid, chatId);
  for (const e of store.listStreamEventsSince(sid, chatId, after)) {
    writeSseEvent(res, e);
  }

  if (rt.status !== 'running') {
    res.end();
    return;
  }

  const unsub = store.subscribeStream(sid, chatId, (e) => {
    try {
      writeSseEvent(res, e);
      if (e.event === 'done' || e.event === 'turn_error' || e.event === 'error') {
        unsub();
        res.end();
      }
    } catch {
      // client likely disconnected
      unsub();
    }
  });

  const k = `${sid}:${chatId}`;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollRunning = false;

  if (!localTurnPumps.has(k)) {
    pollTimer = setInterval(() => {
      if (closed || pollRunning) return;
      pollRunning = true;
      void (async () => {
        try {
          const nowRt = await reconcileRuntimeStatus(sid, chatId);
          if (nowRt.status !== 'running' && !closed) {
            closed = true;
            if (pollTimer) clearInterval(pollTimer);
            unsub();
            res.end();
          }
        } finally {
          pollRunning = false;
        }
      })();
    }, 250);
  }

  res.on('close', () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    unsub();
  });
});

const SendSchema = z.object({
  text: z.string().min(1).max(20_000),
  model: z.string().min(1).optional()
});

const SettingsSchema = z.object({
  model: z.union([z.string().min(1), z.null()]).optional(),
  reasoningEffort: z.union([z.enum(['low', 'medium', 'high', 'xhigh']), z.null()]).optional(),
  cwd: z.union([z.string().min(1), z.null()]).optional(),
  sandbox: z.union([z.enum(['read-only', 'workspace-write', 'danger-full-access']), z.null()]).optional(),
  approvalPolicy: z.union([z.enum(['untrusted', 'on-failure', 'on-request', 'never']), z.null()]).optional()
});

const CompactSchema = z.object({
  keep_last: z.number().int().min(0).max(300).optional()
});

const ActiveChatSchema = z.object({
  chatId: z.string().min(1)
});

const RenameChatSchema = z.object({
  title: z.union([z.string().max(80), z.null()])
});

app.get('/api/session/active-chat', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  res.json({ ok: true, chatId: store.getActiveChatId(sid) || null });
});

app.post('/api/session/active-chat', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const parsed = ActiveChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });
  const ok = store.setActiveChatId(sid, parsed.data.chatId);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/rename', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chat = store.getChat(sid, req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  const parsed = RenameChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const rawTitle = parsed.data.title;
  const nextTitle = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 80) : '';
  const updated = store.renameChat(sid, req.params.chatId, nextTitle || undefined);
  res.json({ ok: true, title: updated.title || null });
});

async function startChatTurn(opts: { sid: string; chatId: string; text: string; model?: string }) {
  const chat = store.getChat(opts.sid, opts.chatId);
  if (!chat) throw new Error('not_found');
  if (await codex.isBusy(opts.sid, opts.chatId)) throw new Error('chat_busy');

  store.appendMessage(opts.sid, opts.chatId, { role: 'user', text: opts.text });
  const assistantMsg = store.appendMessage(opts.sid, opts.chatId, { role: 'assistant', text: '' });

  store.resetStream(opts.sid, opts.chatId);
  store.appendStreamEvent(opts.sid, opts.chatId, 'start', { ok: true, assistantMessageId: assistantMsg.id });
  codex.resetKnownCursor(opts.sid, opts.chatId);

  const settings = chat.settings || {};
  const chatCwd = ensureChatWorkingDirectory(opts.sid, chat);
  const key = `${opts.sid}:${opts.chatId}`;
  void (async () => {
    localTurnPumps.add(key);
    try {
      const r = await codex.runTurn({
        sessionId: opts.sid,
        chatId: opts.chatId,
        prompt: opts.text,
        assistantMessageId: assistantMsg.id,
        config: {
          cwd: chatCwd,
          sandbox: env.CODEX_SANDBOX,
          approvalPolicy: env.CODEX_APPROVAL_POLICY,
          model: opts.model || settings.model || env.CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort || env.CODEX_REASONING_EFFORT
        },
        onEvent: (e) => {
          if (e.type === 'agent_message') {
            store.appendToMessageText(opts.sid, opts.chatId, assistantMsg.id, e.message);
            store.appendStreamEvent(opts.sid, opts.chatId, 'delta', { text: e.message, assistantMessageId: assistantMsg.id });
            return;
          }
          if (e.type === 'approval_request') {
            store.appendStreamEvent(opts.sid, opts.chatId, 'approval_request', e.request);
            return;
          }
          if (
            e.type === 'raw' &&
            typeof (e as any).msg === 'object' &&
            (e as any).msg !== null &&
            (e as any).msg.type === 'progress'
          ) {
            const msg: any = (e as any).msg;
            const stage = typeof msg.stage === 'string' ? msg.stage : 'progress';
            const message = typeof msg.message === 'string' ? msg.message : '';
            store.appendStreamEvent(opts.sid, opts.chatId, 'progress', { stage, message, detail: msg.detail ?? null });
            return;
          }
          store.appendStreamEvent(opts.sid, opts.chatId, 'codex_event', e.msg);
        }
      });
      if (r.usage) store.appendStreamEvent(opts.sid, opts.chatId, 'codex_usage', r.usage);
      if (r.rateLimits) store.appendStreamEvent(opts.sid, opts.chatId, 'codex_rate_limits', r.rateLimits);
      store.appendStreamEvent(opts.sid, opts.chatId, 'done', { ok: true });
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'codex_error';
      store.appendStreamEvent(opts.sid, opts.chatId, 'turn_error', { message: msg });
    } finally {
      localTurnPumps.delete(key);
    }
  })();

  return { assistantMessageId: assistantMsg.id };
}

app.post('/api/chats/:chatId/send_async', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const parsed = SendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  try {
    const r = await startChatTurn({ sid, chatId, text: parsed.data.text, model: parsed.data.model });
    res.json({ ok: true, assistantMessageId: r.assistantMessageId });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg === 'chat_busy') return res.status(409).json({ ok: false, error: 'chat_busy' });
    if (msg === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    res.status(500).json({ ok: false, error: 'start_failed' });
  }
});

// Back-compat: keep `/send` as an SSE stream.
app.post('/api/chats/:chatId/send', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const parsed = SendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  try {
    await startChatTurn({ sid, chatId, text: parsed.data.text, model: parsed.data.model });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg === 'chat_busy') return res.status(409).json({ ok: false, error: 'chat_busy' });
    if (msg === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(500).json({ ok: false, error: 'start_failed' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const e of store.listStreamEventsSince(sid, chatId, 0)) writeSseEvent(res, e);

  const unsub = store.subscribeStream(sid, chatId, (e) => {
    try {
      writeSseEvent(res, e);
      if (e.event === 'done' || e.event === 'turn_error' || e.event === 'error') {
        unsub();
        res.end();
      }
    } catch {
      unsub();
    }
  });

  res.on('close', () => {
    unsub();
  });
});

app.post('/api/chats/:chatId/settings', (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const { sandbox, approvalPolicy, ...rest } = parsed.data;
  void sandbox;
  void approvalPolicy;
  store.updateChatSettings(sid, chatId, rest);
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/reset', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });
  await codex.reset(sid, chatId);
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/compact', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;

  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });

  const stream = store.getStreamRuntime(sid, chatId);
  if (stream.status === 'running') return res.status(409).json({ ok: false, error: 'chat_busy' });

  const parsed = CompactSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const { keep_last: keepLast } = parsed.data;
  const compacted = buildCompactedMessages(chat.messages, keepLast ?? COMPACT_KEEP_LAST_DEFAULT);
  if (compacted.messages.length === 0 || compacted.removedCount === 0) {
    return res.json({ ok: true, compacted: false, removedCount: 0 });
  }

  store.replaceMessages(sid, chatId, compacted.messages);
  res.json({
    ok: true,
    compacted: true,
    removedCount: compacted.removedCount,
    keptCount: compacted.messages.length
  });
});

app.post('/api/chats/:chatId/abort', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const chatId = req.params.chatId;
  const chat = store.getChat(sid, chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'not_found' });
  const r = await codex.abort(sid, chatId);
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  res.json({ ok: true });
});

const ApproveSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort'])
});

app.post('/api/chats/:chatId/approve', async (req, res) => {
  const sid = requireAuth(req, res);
  if (!sid) return;
  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' });

  const ok = await codex.approve(sid, req.params.chatId, parsed.data.id, parsed.data.decision);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

// Serve built web app if present.
const webDist = path.resolve(serverRootDir, '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

async function findAvailablePort(host: string, startPort: number): Promise<number> {
  for (let p = startPort; p < startPort + 200; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, host);
    });
    if (ok) return p;
  }
  // Fall back to ephemeral port.
  return await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.once('listening', () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('failed to allocate ephemeral port'));
      });
    });
    s.listen(0, host);
  });
}

const port = await findAvailablePort(env.HOST, env.PORT);
const server = app.listen(port, env.HOST, () => {
  console.log(`[server] listening on http://${env.HOST}:${port}`);
  console.log(`[server] Codex: sandbox=${env.CODEX_SANDBOX} approvalPolicy=${env.CODEX_APPROVAL_POLICY} cwd=${env.CODEX_CWD}`);
  console.log(
    `[server] Sessiond: http://${env.CODEX_SESSIOND_HOST}:${env.CODEX_SESSIOND_PORT} autoStart=${env.CODEX_SESSIOND_AUTO_START}`
  );
  console.log('[server] Auth mode: totp');
  if (port !== env.PORT) {
    console.log(`[server] Note: requested PORT=${env.PORT} was busy; using PORT=${port}`);
  }

  if (env.HOST === '0.0.0.0') {
    const ifs = os.networkInterfaces();
    const addrs: string[] = [];
    for (const entries of Object.values(ifs)) {
      for (const e of entries || []) {
        if (e.family === 'IPv4' && !e.internal) {
          addrs.push(e.address);
        }
      }
    }
    if (addrs.length) {
      console.log('[server] Accessible on:');
      for (const a of addrs) console.log(`  http://${a}:${port}`);
    }
  }

  if (!env.TOTP_SECRET) {
    console.log('[server] TOTP_SECRET is not set; TOTP login will fail.');
  } else if (env.PRINT_TOTP_QR && !isTotpProvisioned()) {
    const uri = authenticator.keyuri(env.TOTP_ACCOUNT, env.TOTP_ISSUER, env.TOTP_SECRET);
    console.log('[server] Scan this TOTP QR with your authenticator app:');
    qrcode.generate(uri, { small: true });
  } else if (env.PRINT_TOTP_QR && isTotpProvisioned()) {
    console.log(`[server] TOTP already provisioned (marker exists at ${totpProvisionPath}); not printing QR.`);
  }
});

server.on('upgrade', (req, socket, head) => {
  const reqUrl = req.url || '/';
  const host = req.headers.host || `${env.HOST}:${port}`;
  let parsed: URL;
  try {
    parsed = new URL(reqUrl, `http://${host}`);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  if (parsed.pathname !== '/ws/terminal' && parsed.pathname !== '/codex/ws/terminal') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  const sid = readSessionIdFromUpgradeRequest(req);
  if (!sid) {
    console.warn(`[terminal-ws] unauthorized upgrade path=${parsed.pathname}`);
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  const terminalId = parsed.searchParams.get('terminalId')?.trim();
  if (!terminalId) {
    console.warn(`[terminal-ws] missing terminalId sid=${sid}`);
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  const runtime = terminalRuntimeById.get(terminalId);
  if (!runtime || runtime.sid !== sid || runtime.record.status !== 'running') {
    console.warn(
      `[terminal-ws] terminal not found or forbidden sid=${sid} terminalId=${terminalId} found=${Boolean(runtime)}`
    );
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  terminalWss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[terminal-ws] connected sid=${sid} terminalId=${terminalId}`);
    bindTerminalSocket(ws, runtime);
  });
});
