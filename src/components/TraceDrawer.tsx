import { ChatCircleText, Database, GitBranch, Sparkle, X } from "@phosphor-icons/react";
import { agentByName } from "../agents";
import type { TraceStep, TraceTurn } from "../types";

type TraceDrawerProps = {
  open: boolean;
  onClose: () => void;
  traces: TraceTurn[];
};

function stepTitle(step: TraceStep) {
  if (step.type === "call") return "Called specialist";
  if (step.type === "supervisor_final") return "Composed answer";
  if (step.type === "response") return "Received result";
  return step.label ?? "Trace event";
}

function StepIcon({ type }: { type: string }) {
  if (type === "call") return <GitBranch size={14} />;
  if (type === "supervisor_final") return <Sparkle size={14} />;
  if (type === "response") return <Database size={14} />;
  return <ChatCircleText size={14} />;
}

function compactValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function preview(text: string, max = 180) {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function agentLabel(step: TraceStep) {
  const agent = agentByName(step.agent);
  if (agent) return agent.name;
  if (step.agent?.startsWith("genie-")) return "Customer Intelligence Agent";
  return step.agent || "Agent";
}

export function TraceDrawer({ open, onClose, traces }: TraceDrawerProps) {
  return (
    <>
      {open ? <button className="drawer-scrim" onClick={onClose} type="button" aria-label="Close trace drawer" /> : null}
      <aside className={`trace-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="drawer-header">
          <div>
            <h2>Agent Trace</h2>
            <p>{traces.length ? `${traces.length} turn${traces.length === 1 ? "" : "s"} recorded` : "No trace yet"}</p>
          </div>
          <button onClick={onClose} type="button" aria-label="Close trace drawer"><X size={18} /></button>
        </div>
        <div className="trace-list">
          {!traces.length ? (
            <div className="empty-trace">
              <span className="empty-trace-icon"><GitBranch size={17} /></span>
              <strong>No agent route yet</strong>
              <p>Ask a question and the trace will show which specialist handled it, what was queried, and how the final answer was assembled.</p>
            </div>
          ) : null}
          {traces.map((turn, index) => (
            <section className="trace-turn" key={turn.id}>
              <div className="trace-turn-header">
                <span>Turn {index + 1}</span>
                <strong>{turn.trace.length} event{turn.trace.length === 1 ? "" : "s"}</strong>
              </div>
              <p className="trace-query">{turn.query}</p>
              <div className="trace-steps">
                {turn.trace.map((step, stepIndex) => {
                  const agent = agentByName(step.agent);
                  const AgentIcon = agent?.icon;
                  const queryText = compactValue(step.query);
                  const contentText = compactValue(step.content);
                return (
                  <div className="trace-step" key={`${turn.id}-${stepIndex}`}>
                    <span className={`trace-step-icon ${step.type}`} aria-hidden="true"><StepIcon type={step.type} /></span>
                    <div>
                      <div className="trace-step-head">
                        <strong>{stepTitle(step)}</strong>
                        {typeof step.duration_ms === "number" ? <time>{(step.duration_ms / 1000).toFixed(1)}s</time> : null}
                      </div>
                      <small>{AgentIcon ? <AgentIcon size={14} /> : null}{agentLabel(step)}</small>
                      {queryText ? <code>{preview(queryText, 150)}</code> : null}
                      {contentText ? <p>{preview(contentText)}</p> : null}
                    </div>
                  </div>
                );
                })}
              </div>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
