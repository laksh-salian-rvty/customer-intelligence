import { useState } from "react";
import { ChatView } from "./components/ChatView";
import { DashboardView } from "./components/DashboardView";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TraceDrawer } from "./components/TraceDrawer";
import { useChat } from "./hooks/useChat";
import { useSessions } from "./hooks/useSessions";
import type { ViewMode } from "./types";

export function App() {
  const [mode, setMode] = useState<ViewMode>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatScrolled, setChatScrolled] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const sessions = useSessions();
  const chat = useChat(sessions.activeSession, sessions.updateSession);

  return (
    <div className="app-shell">
      <Header
        chatScrolled={mode === "chat" && chatScrolled}
        mode={mode}
        onModeChange={setMode}
        sidebarOpen={mode === "chat" && sidebarOpen}
        onTraceToggle={() => setTraceOpen((open) => !open)}
        traceCount={chat.traces.length}
        traceOpen={traceOpen}
      />
      <div className={`app-body ${mode}`}>
        {mode === "chat" ? (
          <Sidebar
            activeSessionId={sessions.activeSessionId}
            onDeleteSession={sessions.deleteSession}
            onNewSession={sessions.newSession}
            onRenameSession={sessions.renameSession}
            onSelectSession={sessions.setActiveSessionId}
            onTogglePinSession={sessions.togglePinSession}
            onToggle={() => setSidebarOpen((open) => !open)}
            open={sidebarOpen}
            sessions={sessions.sessions}
          />
        ) : null}
        {mode === "chat" ? (
          <ChatView
            loading={chat.loading}
            messages={chat.messages}
            onScrollStateChange={setChatScrolled}
            onSend={chat.send}
            threadKey={sessions.activeSessionId}
          />
        ) : null}
        <div className={`dashboard-cache ${mode === "dashboard" ? "active" : ""}`} aria-hidden={mode !== "dashboard"}>
          <DashboardView />
        </div>
      </div>
      <TraceDrawer open={traceOpen} onClose={() => setTraceOpen(false)} traces={chat.traces} />
    </div>
  );
}
