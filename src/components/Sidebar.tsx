import { DotsThree, MagnifyingGlass, PencilSimple, Plus, PushPin, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SidebarToggle } from "./Header";
import type { ChatSession } from "../types";

type SidebarProps = {
  activeSessionId: string;
  onDeleteSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSelectSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  onToggle: () => void;
  open: boolean;
  sessions: ChatSession[];
};

export function Sidebar({ activeSessionId, onDeleteSession, onNewSession, onRenameSession, onSelectSession, onToggle, onTogglePinSession, open, sessions }: SidebarProps) {
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const sidebarRef = useRef<HTMLElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(query));
  }, [search, sessions]);

  const submitRename = (session: ChatSession, title: string) => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== session.title) onRenameSession(session.id, trimmed);
    setRenamingSessionId(null);
  };

  useEffect(() => {
    if (!renamingSessionId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renamingSessionId]);

  useEffect(() => {
    if (!menuSessionId) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest(".session-menu, .session-menu-button")) return;
      setMenuSessionId(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuSessionId(null);
    };

    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuSessionId]);

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} ref={sidebarRef}>
      <div className="sidebar-inner">
        <div className="sidebar-header">
          <SidebarToggle onClick={onToggle} open={open} />
          <div className="sidebar-title-block">
            <h2>Chats</h2>
          </div>
          <button className="new-chat-button" onClick={onNewSession} type="button" aria-label="New chat" title="New chat">
            <Plus size={18} />
          </button>
        </div>
        <div className="sidebar-expanded-content" aria-hidden={!open}>
          {sessions.length ? (
            <label className="sidebar-search">
              <MagnifyingGlass size={15} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats" type="search" />
            </label>
          ) : null}
          {filteredSessions.length ? (
            <nav className="session-list" aria-label="Chat sessions">
              {filteredSessions.map((session) => (
                <div className={`session-row ${session.id === activeSessionId ? "active" : ""} ${menuSessionId === session.id ? "menu-open" : ""} ${renamingSessionId === session.id ? "renaming" : ""}`} key={session.id}>
                  {renamingSessionId === session.id ? (
                    <div className="session-rename-wrap">
                      <input
                        ref={renameInputRef}
                        className="session-rename-input"
                        defaultValue={session.title}
                        onBlur={(event) => submitRename(session, event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setRenamingSessionId(null);
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      <button className="session-button" onClick={() => { onSelectSession(session.id); setMenuSessionId(null); }} type="button">
                        {session.pinned ? <PushPin className="session-pin" size={12} weight="fill" /> : null}
                        <span>{session.title}</span>
                      </button>
                      <button className="session-menu-button" onClick={(event) => { event.stopPropagation(); setMenuSessionId((current) => current === session.id ? null : session.id); }} type="button" aria-label={`Open menu for ${session.title}`} aria-expanded={menuSessionId === session.id}>
                        <DotsThree size={18} weight="bold" />
                      </button>
                      {menuSessionId === session.id ? (
                        <div className="session-menu" role="menu">
                          <button onClick={() => { setRenamingSessionId(session.id); setMenuSessionId(null); }} role="menuitem" type="button"><PencilSimple size={15} weight="bold" /> Rename</button>
                          <button onClick={() => { onTogglePinSession(session.id); setMenuSessionId(null); }} role="menuitem" type="button"><PushPin size={15} weight="bold" /> {session.pinned ? "Unpin" : "Pin"}</button>
                          <button className="danger" onClick={() => { onDeleteSession(session.id); setMenuSessionId(null); }} role="menuitem" type="button"><Trash size={15} weight="bold" /> Delete</button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </nav>
          ) : sessions.length ? (
            <p className="sidebar-empty">No chats found.</p>
          ) : (
            <p className="sidebar-empty">No saved chats yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
