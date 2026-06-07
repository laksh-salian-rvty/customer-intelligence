import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatSession, Message, TraceTurn } from "../types";

const STORAGE_KEY = "revvity-agent-hub-sessions";

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function titleFrom(messages: Message[]) {
  const firstUser = messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.trim().split(/\s+/).length > 3);
  if (!firstUser) return "New Chat";
  const title = firstUser.content.trim().replace(/\s+/g, " ");
  return title.length > 42 ? `${title.slice(0, 39)}...` : title;
}

function createSession(): ChatSession {
  const createdAt = now();
  return {
    id: id("session"),
    title: "New Chat",
    messages: [],
    traces: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function normalizeMessage(message: unknown): Message | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Partial<Message>;
  if (value.role !== "user" && value.role !== "assistant") return null;
  return {
    id: typeof value.id === "string" ? value.id : id("message"),
    role: value.role,
    content: typeof value.content === "string" ? value.content : "",
    loading: Boolean(value.loading),
    routing: value.routing ?? null,
    follow_ups: Array.isArray(value.follow_ups) ? value.follow_ups.filter((item): item is string => typeof item === "string") : undefined,
    streamStatus: value.streamStatus ?? null,
  };
}

function normalizeSession(session: unknown): ChatSession | null {
  if (!session || typeof session !== "object") return null;
  const value = session as Partial<ChatSession>;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : now();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const messages = Array.isArray(value.messages) ? value.messages.map(normalizeMessage).filter((message): message is Message => Boolean(message)) : [];
  return {
    id: typeof value.id === "string" ? value.id : id("session"),
    title: typeof value.title === "string" ? value.title : titleFrom(messages),
    messages,
    pinned: Boolean(value.pinned),
    traces: Array.isArray(value.traces) ? value.traces : [],
    createdAt,
    updatedAt,
  };
}

function readSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSession)
      .filter((session): session is ChatSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function hasConversation(session: ChatSession) {
  return Array.isArray(session.messages) && session.messages.some((message) => !message.loading);
}

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const existing = readSessions();
    return existing.length ? existing : [createSession()];
  });
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id ?? "");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );

  const sortedSessions = useMemo(
    () => [...sessions]
      .filter(hasConversation)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );

  const newSession = useCallback(() => {
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    if (activeSession && !hasConversation(activeSession)) return;

    const session = createSession();
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
  }, [activeSessionId, sessions]);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      if (!next.length) {
        const replacement = createSession();
        setActiveSessionId(replacement.id);
        return [replacement];
      }
      if (sessionId === activeSessionId) setActiveSessionId(next[0].id);
      return next;
    });
  }, [activeSessionId]);

  const updateSession = useCallback((sessionId: string, messages: Message[], traces?: TraceTurn[]) => {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== sessionId) return session;
        const updatedAt = now();
        const nextMessages = messages;
        return {
          ...session,
          title: titleFrom(nextMessages),
          messages: nextMessages,
          traces: traces ?? session.traces,
          updatedAt,
        };
      }),
    );
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, title: nextTitle, updatedAt: now() }
          : session,
      ),
    );
  }, []);

  const togglePinSession = useCallback((sessionId: string) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, pinned: !session.pinned, updatedAt: now() }
          : session,
      ),
    );
  }, []);

  const updateActiveSession = useCallback((messages: Message[], traces?: TraceTurn[]) => {
    updateSession(activeSessionId, messages, traces);
  }, [activeSessionId, updateSession]);

  return {
    activeSession,
    activeSessionId,
    deleteSession,
    newSession,
    renameSession,
    sessions: sortedSessions,
    setActiveSessionId,
    togglePinSession,
    updateActiveSession,
    updateSession,
  };
}
