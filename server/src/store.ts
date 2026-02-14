import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Session = {
  id: string;
  createdAt: number;
  expiresAt: number;
  activeChatId?: string;
  createdBySessionId?: string;
  createdByCredentialId?: string;
  isPersistent?: boolean;
};

export type CredentialRecord = {
  id: string;
  tokenHash: string;
  label?: string;
  createdBySessionId: string;
  createdAt: number;
  lastUsedAt?: number;
  usedCount?: number;
  revokedAt?: number;
};

export type PublicCredentialRecord = Omit<CredentialRecord, 'tokenHash'>;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
};

export type ChatSettings = {
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
};

// `null` means "clear this setting" (remove override and fall back to defaults).
export type ChatSettingsPatch = {
  model?: string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
  cwd?: string | null;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
};

export type Chat = {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  settings: ChatSettings;
};

export type StreamEvent = {
  id: number;
  event: string;
  data: any;
  ts: number;
};

export type TerminalSessionRecord = {
  id: string;
  createdAt: number;
  cwd: string;
  status: 'running' | 'stopped';
};

type ChatStream = {
  status: 'idle' | 'running' | 'done' | 'error';
  nextId: number;
  events: StreamEvent[];
  listeners: Set<(e: StreamEvent) => void>;
  updatedAt: number;
};

type PersistedStore = {
  version: number;
  savedAt: number;
  sessions: Session[];
  chatsBySession: { [sessionId: string]: Chat[] };
  credentials: CredentialRecord[];
};

export class MemoryStore {
  private sessions = new Map<string, Session>();
  private chatsBySession = new Map<string, Map<string, Chat>>();
  private terminalSessionsBySid = new Map<string, TerminalSessionRecord[]>();
  private streamsByChatKey = new Map<string, ChatStream>();
  private credentials = new Map<string, CredentialRecord>();
  private credentialsByOwner = new Map<string, Set<string>>();
  private credentialById = new Map<string, string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistenceVersion = 3;
  private persistencePath?: string;

  constructor(private opts: {
    sessionTtlMs: number;
    persistencePath?: string;
  }) {
    this.persistencePath = this.opts.persistencePath?.trim();
    if (this.persistencePath) {
      this.loadFromDisk();
    }
  }

  private now() {
    return Date.now();
  }

  private sha256Hex(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
  }

  private resolveExpiresAt(isPersistent: boolean) {
    return this.now() + this.opts.sessionTtlMs;
  }

  private markForPersist() {
    if (!this.persistencePath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk();
    }, 250);
  }

  private persistToDisk() {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

      const data: PersistedStore = {
        version: this.persistenceVersion,
        savedAt: this.now(),
        sessions: Array.from(this.sessions.values()),
        chatsBySession: Object.fromEntries(
          Array.from(this.chatsBySession.entries()).map(([sid, chats]) => [sid, Array.from(chats.values())])
        ),
        credentials: Array.from(this.credentials.values())
      };

      const tmp = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.persistencePath);
    } catch {
      // persistence failure should not block runtime
    }
  }

  private isSessionLike(v: unknown): v is Session {
    return (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Session).id === 'string' &&
      typeof (v as Session).createdAt === 'number' &&
      typeof (v as Session).expiresAt === 'number' &&
      (!(v as Session).activeChatId || typeof (v as Session).activeChatId === 'string')
    );
  }

  private isChatLike(v: unknown): v is Chat {
    return (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Chat).id === 'string' &&
      typeof (v as Chat).createdAt === 'number' &&
      typeof (v as Chat).updatedAt === 'number' &&
      Array.isArray((v as Chat).messages) &&
      typeof (v as Chat).settings === 'object' &&
      (v as Chat).settings !== null
    );
  }

  private isCredentialLike(v: unknown): v is CredentialRecord {
    return (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as CredentialRecord).id === 'string' &&
      typeof (v as CredentialRecord).tokenHash === 'string' &&
      typeof (v as CredentialRecord).createdBySessionId === 'string' &&
      typeof (v as CredentialRecord).createdAt === 'number' &&
      (!(v as CredentialRecord).label || typeof (v as CredentialRecord).label === 'string') &&
      (!(v as CredentialRecord).lastUsedAt || typeof (v as CredentialRecord).lastUsedAt === 'number') &&
      (!(v as CredentialRecord).usedCount || Number.isInteger((v as CredentialRecord).usedCount as number))
    );
  }

  private loadFromDisk() {
    if (!this.persistencePath) return;
    try {
      const raw = fs.readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedStore>;
      if (!parsed || typeof parsed !== 'object') return;

      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      for (const s of sessions) {
        if (!this.isSessionLike(s)) continue;
        this.sessions.set(s.id, s);
      }

      const rawChats = parsed.chatsBySession;
      if (rawChats && typeof rawChats === 'object') {
        for (const [sid, chatsValue] of Object.entries(rawChats)) {
          if (!Array.isArray(chatsValue) || !this.sessions.has(sid)) continue;
          const m = new Map<string, Chat>();
          for (const chatValue of chatsValue) {
            if (!this.isChatLike(chatValue)) continue;
            const safeMessages = Array.isArray(chatValue.messages)
              ? chatValue.messages.filter(
                  (msg): msg is ChatMessage =>
                    typeof msg === 'object' &&
                    msg !== null &&
                    typeof (msg as ChatMessage).id === 'string' &&
                    (['user', 'assistant', 'system'] as const).includes((msg as ChatMessage).role as any) &&
                    typeof (msg as ChatMessage).text === 'string' &&
                    typeof (msg as ChatMessage).createdAt === 'number'
                )
              : [];

            const safeSettings = {
              model: typeof chatValue.settings?.model === 'string' ? chatValue.settings.model : undefined,
              reasoningEffort:
                chatValue.settings?.reasoningEffort === 'low' ||
                chatValue.settings?.reasoningEffort === 'medium' ||
                chatValue.settings?.reasoningEffort === 'high' ||
                chatValue.settings?.reasoningEffort === 'xhigh'
                  ? chatValue.settings?.reasoningEffort
                  : undefined,
              cwd: typeof chatValue.settings?.cwd === 'string' ? chatValue.settings.cwd : undefined,
              sandbox:
                chatValue.settings?.sandbox === 'read-only' ||
                chatValue.settings?.sandbox === 'workspace-write' ||
                chatValue.settings?.sandbox === 'danger-full-access'
                  ? chatValue.settings.sandbox
                  : undefined,
              approvalPolicy:
                chatValue.settings?.approvalPolicy === 'untrusted' ||
                chatValue.settings?.approvalPolicy === 'on-failure' ||
                chatValue.settings?.approvalPolicy === 'on-request' ||
                chatValue.settings?.approvalPolicy === 'never'
                  ? chatValue.settings.approvalPolicy
                  : undefined
            };

            const chat: Chat = {
              id: chatValue.id,
              createdAt: chatValue.createdAt,
              updatedAt: chatValue.updatedAt,
              messages: safeMessages,
              settings: safeSettings
            };

            m.set(chat.id, chat);
          }

          if (m.size > 0) {
            this.chatsBySession.set(sid, m);
          }
        }
      }

      const rawCredentials = parsed.credentials;
      if (rawCredentials && Array.isArray(rawCredentials)) {
        for (const credentialValue of rawCredentials) {
          if (!this.isCredentialLike(credentialValue)) continue;
          if (credentialValue.revokedAt) continue;
          const rec: CredentialRecord = {
            ...credentialValue,
            usedCount: typeof credentialValue.usedCount === 'number' ? credentialValue.usedCount : 0
          };
          this.credentials.set(rec.tokenHash, rec);
          this.credentialById.set(rec.id, rec.tokenHash);
          this.addCredentialOwner(rec.createdBySessionId, rec.id);
        }
      }
    } catch {
      // ignore bad/old/missing persistence file
    }
  }

  sweep() {
    let changed = false;
    const t = this.now();

    // Drop old/finished streams and any streams for expired sessions.
    const streamTtlMs = 15 * 60 * 1000;
    for (const [k, s] of this.streamsByChatKey) {
      const sid = k.split(':', 1)[0] || '';
      if (s.status !== 'running' && s.updatedAt + streamTtlMs <= t) {
        this.streamsByChatKey.delete(k);
        changed = true;
      }
    }

    const credentialIds = Array.from(this.credentialById.keys());
    for (const credentialId of credentialIds) {
      const rec = this.getCredentialById(credentialId);
      if (!rec) {
        this.credentialsByOwner.forEach((set) => set.delete(credentialId));
        this.credentialById.delete(credentialId);
        changed = true;
      }
    }

    if (changed) this.markForPersist();
  }

  private addCredentialOwner(ownerSessionId: string, credentialId: string) {
    let set = this.credentialsByOwner.get(ownerSessionId);
    if (!set) {
      set = new Set();
      this.credentialsByOwner.set(ownerSessionId, set);
    }
    set.add(credentialId);
  }

  private removeCredentialOwner(ownerSessionId: string, credentialId: string) {
    const set = this.credentialsByOwner.get(ownerSessionId);
    if (!set) return;
    set.delete(credentialId);
    if (!set.size) this.credentialsByOwner.delete(ownerSessionId);
  }

  private getCredentialById(credentialId: string): CredentialRecord | null {
    const tokenHash = this.credentialById.get(credentialId);
    if (!tokenHash) return null;
    return this.credentials.get(tokenHash) || null;
  }

  createSession(opts: { createdBySessionId?: string; createdByCredentialId?: string; isPersistent?: boolean } = {}): Session {
    const createdAt = this.now();
    const id = nanoid(24);
    const session: Session = {
      id,
      createdAt,
      expiresAt: this.resolveExpiresAt(Boolean(opts.isPersistent)),
      activeChatId: undefined,
      isPersistent: opts.isPersistent,
      ...opts
    };
    this.sessions.set(id, session);
    this.markForPersist();
    return session;
  }

  // Use a stable id to make multiple devices share the same logical session (e.g. TOTP account).
  getOrCreateSessionWithId(id: string, options: { isPersistent?: boolean } = {}): Session {
    const now = this.now();
    const existing = this.sessions.get(id);
    if (existing) {
      existing.expiresAt = this.resolveExpiresAt(Boolean(options.isPersistent || existing.isPersistent));
      if (typeof options.isPersistent === 'boolean') {
        existing.isPersistent = options.isPersistent;
      }
      this.sessions.set(id, existing);
      this.markForPersist();
      return existing;
    }

    const session: Session = {
      id,
      createdAt: now,
      expiresAt: this.resolveExpiresAt(Boolean(options.isPersistent)),
      activeChatId: undefined,
      isPersistent: options.isPersistent
    };
    this.sessions.set(id, session);
    this.markForPersist();
    return session;
  }

  createCredential(sessionId: string, label?: string): { token: string; id: string; createdAt: number; label?: string } {
    let token = '';
    let tokenHash = '';
    do {
      token = crypto.randomBytes(32).toString('base64url');
      tokenHash = this.sha256Hex(token);
    } while (this.credentials.has(tokenHash));

    const now = this.now();
    const rec: CredentialRecord = {
      id: nanoid(10),
      tokenHash,
      label: label?.trim() || undefined,
      createdBySessionId: sessionId,
      createdAt: now,
      usedCount: 0
    };

    this.credentials.set(tokenHash, rec);
    this.credentialById.set(rec.id, tokenHash);
    this.addCredentialOwner(sessionId, rec.id);
    this.markForPersist();
    return { token, id: rec.id, createdAt: now, label: rec.label };
  }

  listCredentialsForSession(sessionId: string): PublicCredentialRecord[] {
    const ids = this.credentialsByOwner.get(sessionId);
    if (!ids) return [];

    const out: PublicCredentialRecord[] = [];
    for (const id of ids) {
      const rec = this.getCredentialById(id);
      if (!rec) continue;
      if (rec.createdBySessionId !== sessionId) continue;
      if (rec.revokedAt) continue;
      out.push({
        id: rec.id,
        label: rec.label,
        createdBySessionId: rec.createdBySessionId,
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt,
        usedCount: rec.usedCount
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  consumeCredential(token: string): { ok: true; session: Session; credentialId: string } | { ok: false; error: string } {
    const tokenHash = this.sha256Hex(token);
    const rec = this.credentials.get(tokenHash);
    if (!rec) return { ok: false, error: 'invalid_credential' };
    if (rec.revokedAt) return { ok: false, error: 'revoked_credential' };

    const now = this.now();
    rec.lastUsedAt = now;
    rec.usedCount = (rec.usedCount || 0) + 1;
    this.credentials.set(tokenHash, rec);
    this.markForPersist();

    const session = this.createSession({
      createdBySessionId: rec.createdBySessionId,
      createdByCredentialId: rec.id
    });
    return { ok: true, session, credentialId: rec.id };
  }

  revokeCredential(sessionId: string, credentialId: string): boolean {
    const rec = this.getCredentialById(credentialId);
    if (!rec) return false;
    if (rec.createdBySessionId !== sessionId) return false;
    if (rec.revokedAt) return false;

    rec.revokedAt = this.now();
    this.credentials.set(rec.tokenHash, rec);
    this.removeCredentialOwner(sessionId, rec.id);
    this.markForPersist();
    return true;
  }

  getSession(id: string): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      return null;
    }
    return s;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      activeChatId: s.activeChatId,
      createdBySessionId: s.createdBySessionId,
      createdByCredentialId: s.createdByCredentialId
    }));
  }

  refreshSession(id: string): Session | null {
    const s = this.getSession(id);
    if (!s) return null;
    s.expiresAt = this.now() + this.opts.sessionTtlMs;
    this.sessions.set(id, s);
    this.markForPersist();
    return s;
  }

  getActiveChatId(sessionId: string): string | null {
    const s = this.getSession(sessionId);
    if (!s?.activeChatId) return null;
    const m = this.getChatsMapForSession(sessionId);
    if (!m.has(s.activeChatId)) {
      s.activeChatId = undefined;
      this.sessions.set(sessionId, s);
      this.markForPersist();
      return null;
    }
    return s.activeChatId;
  }

  setActiveChatId(sessionId: string, chatId: string): boolean {
    const s = this.getSession(sessionId);
    if (!s) return false;
    const m = this.getChatsMapForSession(sessionId);
    if (!m.has(chatId)) return false;
    s.activeChatId = chatId;
    this.sessions.set(sessionId, s);
    this.markForPersist();
    return true;
  }

  private getChatsMapForSession(sessionId: string): Map<string, Chat> {
    let m = this.chatsBySession.get(sessionId);
    if (!m) {
      m = new Map();
      this.chatsBySession.set(sessionId, m);
    }
    return m;
  }

  private chatKey(sessionId: string, chatId: string): string {
    return `${sessionId}:${chatId}`;
  }

  private ensureStream(sessionId: string, chatId: string): ChatStream {
    const key = this.chatKey(sessionId, chatId);
    let s = this.streamsByChatKey.get(key);
    if (!s) {
      s = { status: 'idle', nextId: 1, events: [], listeners: new Set(), updatedAt: this.now() };
      this.streamsByChatKey.set(key, s);
    }
    return s;
  }

  resetStream(sessionId: string, chatId: string): void {
    const s = this.ensureStream(sessionId, chatId);
    s.status = 'running';
    s.events = [];
    s.nextId = 1;
      s.updatedAt = this.now();
    // keep listeners
    this.streamsByChatKey.set(this.chatKey(sessionId, chatId), s);
  }

  getStreamRuntime(sessionId: string, chatId: string): { status: ChatStream['status']; lastEventId: number; updatedAt: number } {
    const s = this.ensureStream(sessionId, chatId);
    const lastEventId = Math.max(0, s.nextId - 1);
    return { status: s.status, lastEventId, updatedAt: s.updatedAt };
  }

  appendStreamEvent(sessionId: string, chatId: string, event: string, data: any): StreamEvent {
    const s = this.ensureStream(sessionId, chatId);
    const e: StreamEvent = { id: s.nextId++, event, data, ts: this.now() };
    s.events.push(e);
    if (event === 'done') s.status = 'done';
    // Keep backward-compat for older event name "error".
    if (event === 'turn_error' || event === 'error') s.status = 'error';
    s.updatedAt = this.now();

    // Bound memory. If client falls behind, it can always fall back to GET /api/chats/:id.
    const maxEvents = 2000;
    if (s.events.length > maxEvents) {
      s.events.splice(0, s.events.length - maxEvents);
    }

    // Notify subscribers.
    for (const fn of s.listeners) fn(e);
    this.streamsByChatKey.set(this.chatKey(sessionId, chatId), s);
    return e;
  }

  listStreamEventsSince(sessionId: string, chatId: string, afterId: number): StreamEvent[] {
    const s = this.ensureStream(sessionId, chatId);
    return s.events.filter((e) => e.id > afterId);
  }

  subscribeStream(sessionId: string, chatId: string, fn: (e: StreamEvent) => void): () => void {
    const s = this.ensureStream(sessionId, chatId);
    s.listeners.add(fn);
    this.streamsByChatKey.set(this.chatKey(sessionId, chatId), s);
    return () => {
      const cur = this.streamsByChatKey.get(this.chatKey(sessionId, chatId));
      if (!cur) return;
      cur.listeners.delete(fn);
      this.streamsByChatKey.set(this.chatKey(sessionId, chatId), cur);
    };
  }

  createChat(sessionId: string): Chat {
    const id = nanoid(14);
    const now = this.now();
    const chat: Chat = { id, createdAt: now, updatedAt: now, messages: [], settings: {} };
    const m = this.getChatsMapForSession(sessionId);
    m.set(id, chat);
    const s = this.getSession(sessionId);
    if (s) {
      s.activeChatId = id;
      this.sessions.set(sessionId, s);
    }
    this.markForPersist();
    return chat;
  }

  listChats(sessionId: string): { id: string; updatedAt: number; createdAt: number; preview?: string }[] {
    const m = this.getChatsMapForSession(sessionId);
    const arr = Array.from(m.values()).map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      preview: c.messages.slice(-1)[0]?.text
    }));
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    return arr;
  }

  deleteChat(sessionId: string, chatId: string): boolean {
    const m = this.chatsBySession.get(sessionId);
    if (!m || !m.has(chatId)) return false;

    const removed = m.delete(chatId);
    if (removed && m.size === 0) {
      this.chatsBySession.delete(sessionId);
    }

    if (removed) {
      const s = this.sessions.get(sessionId);
      if (s && s.activeChatId === chatId) {
        s.activeChatId = undefined;
        this.sessions.set(sessionId, s);
      }
      this.streamsByChatKey.delete(this.chatKey(sessionId, chatId));
      this.markForPersist();
    }

    return removed;
  }

  getChat(sessionId: string, chatId: string): Chat | null {
    const m = this.getChatsMapForSession(sessionId);
    return m.get(chatId) || null;
  }

  updateChatSettings(sessionId: string, chatId: string, patch: ChatSettingsPatch): ChatSettings {
    const chat = this.getChat(sessionId, chatId);
    if (!chat) throw new Error('chat_not_found');
    const next: ChatSettings = { ...chat.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        delete (next as any)[k];
      } else if (typeof v !== 'undefined') {
        (next as any)[k] = v;
      }
    }
    chat.settings = next;
    chat.updatedAt = this.now();
    this.markForPersist();
    return chat.settings;
  }

  appendMessage(sessionId: string, chatId: string, msg: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): ChatMessage {
    const chat = this.getChat(sessionId, chatId);
    if (!chat) throw new Error('chat_not_found');
    const full: ChatMessage = {
      id: msg.id ?? nanoid(12),
      role: msg.role,
      text: msg.text,
      createdAt: msg.createdAt ?? this.now()
    };
    chat.messages.push(full);
    chat.updatedAt = this.now();
    this.markForPersist();
    return full;
  }

  appendToMessageText(sessionId: string, chatId: string, messageId: string, delta: string): void {
    const chat = this.getChat(sessionId, chatId);
    if (!chat) throw new Error('chat_not_found');
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) throw new Error('message_not_found');
    chat.messages[idx] = { ...chat.messages[idx], text: chat.messages[idx].text + delta };
    chat.updatedAt = this.now();
    this.markForPersist();
  }

  setMessageText(sessionId: string, chatId: string, messageId: string, text: string): void {
    const chat = this.getChat(sessionId, chatId);
    if (!chat) throw new Error('chat_not_found');
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) throw new Error('message_not_found');
    chat.messages[idx] = { ...chat.messages[idx], text };
    chat.updatedAt = this.now();
    this.markForPersist();
  }

  replaceMessages(sessionId: string, chatId: string, messages: ChatMessage[]): ChatMessage[] {
    const chat = this.getChat(sessionId, chatId);
    if (!chat) throw new Error('chat_not_found');
    const now = this.now();
    const safe = Array.isArray(messages)
      ? messages
        .map((m, i): ChatMessage => {
          const role = m?.role === 'user' || m?.role === 'assistant' || m?.role === 'system'
            ? m.role
            : 'system';
          const text = typeof m?.text === 'string' ? m.text : '';
          return {
            id: typeof m?.id === 'string' && m.id ? m.id : `msg-${now}-${i}`,
            role,
            text,
            createdAt: typeof m?.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : now
          };
        })
      : [];
    chat.messages = safe;
    chat.updatedAt = now;
    this.markForPersist();
    return chat.messages;
  }

  createTerminalSession(sid: string, cwd: string): TerminalSessionRecord {
    const record: TerminalSessionRecord = {
      id: `terminal_${nanoid(9)}`,
      createdAt: this.now(),
      cwd,
      status: 'running'
    };
    const list = this.terminalSessionsBySid.get(sid) || [];
    list.unshift(record);
    while (list.length > 20) {
      list.pop();
    }
    this.terminalSessionsBySid.set(sid, list);
    return record;
  }

  listTerminalSessions(sid: string): TerminalSessionRecord[] {
    const list = this.terminalSessionsBySid.get(sid);
    if (!list) return [];
    return list.map((item) => ({ ...item }));
  }

  setTerminalSessionStopped(sid: string, terminalId: string): boolean {
    const list = this.terminalSessionsBySid.get(sid);
    if (!list) return false;
    const idx = list.findIndex((item) => item.id === terminalId);
    if (idx < 0) return false;
    const item = list[idx];
    if (!item || item.status === 'stopped') return false;
    list[idx] = { ...item, status: 'stopped' };
    return true;
  }
}
