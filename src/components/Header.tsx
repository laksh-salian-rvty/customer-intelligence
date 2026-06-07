import { ChatCircle, ChartBar, GitBranch, SidebarSimple } from "@phosphor-icons/react";
import type { ViewMode } from "../types";

type HeaderProps = {
  chatScrolled: boolean;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onTraceToggle: () => void;
  sidebarOpen: boolean;
  traceCount: number;
  traceOpen: boolean;
};

export function Header({ chatScrolled, mode, onModeChange, onTraceToggle, sidebarOpen, traceCount, traceOpen }: HeaderProps) {
  return (
    <header className={`app-header ${chatScrolled ? "scrolled" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="wordmark">Customer Intelligence</div>
      <div className={`mode-toggle ${mode}`} aria-label="View mode">
        <span className="mode-toggle-indicator" aria-hidden="true" />
        <button className={mode === "chat" ? "active" : ""} onClick={() => onModeChange("chat")} type="button">
          <ChatCircle size={16} />
          Chat
        </button>
        <button className={mode === "dashboard" ? "active" : ""} onClick={() => onModeChange("dashboard")} type="button">
          <ChartBar size={16} />
          Dashboard
        </button>
      </div>
      <div className="header-spacer" />
      <button className={`icon-text-button trace-toggle ${traceOpen ? "active" : ""}`} onClick={onTraceToggle} type="button">
        <GitBranch size={16} />
        Trace
        {traceCount > 0 ? <span className="count-pill">{traceCount}</span> : null}
      </button>
    </header>
  );
}

export function SidebarToggle({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button className="sidebar-toggle" onClick={onClick} type="button" aria-label="Toggle chats sidebar" aria-expanded={open}>
      <SidebarSimple size={20} />
      <span className="sidebar-toggle-label">Chats</span>
    </button>
  );
}
