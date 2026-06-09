import { CaretRight, ChatCircleText, Database, GearSix, MagnifyingGlass, Wrench } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { StreamStatus, StreamStep } from "../types";

export function TypingDots() {
  return (
    <div className="typing-dots" aria-label="Loading">
      <span />
      <span />
      <span />
    </div>
  );
}

function formatDuration(ms: number) {
  const secondsExact = Math.max(0, ms / 1000);
  const seconds = Math.floor(secondsExact);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatStepDuration(ms: number, active = false) {
  const seconds = Math.max(0, ms / 1000);
  if (active) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function stepDuration(step: StreamStep, now: number) {
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

function timelineDuration(steps: StreamStep[], now: number) {
  if (!steps.length) return 0;
  const startedAt = Math.min(...steps.map((step) => step.startedAt));
  const endedAt = Math.max(...steps.map((step) => step.endedAt ?? now));
  return Math.max(0, endedAt - startedAt);
}

function StepIcon({ kind }: { kind?: StreamStep["kind"] }) {
  if (kind === "retrieval") return <MagnifyingGlass size={12} weight="regular" />;
  if (kind === "tool") return <Wrench size={12} weight="regular" />;
  if (kind === "query") return <Database size={12} weight="regular" />;
  if (kind === "system") return <GearSix size={12} weight="regular" />;
  return <ChatCircleText size={12} weight="regular" />;
}

type DisplayStep = StreamStep & {
  count?: number;
  durationMs?: number;
};

function displayLabel(step: StreamStep) {
  if (step.kind === "system" && step.label.startsWith("Querying ")) {
    return step.label.replace(/^Querying\s+/, "");
  }
  if (step.label === "Reasoning over results") return "Reasoning";
  return step.label;
}

function completedLabel(step: StreamStep) {
  const label = displayLabel(step);
  if (label === "Reasoning") return label;
  if (label === "Loading examples") return "Loaded examples";
  if (label === "Composing answer") return "Composed answer";
  if (label.startsWith("Querying ")) return label.replace(/^Querying\s+/, "");
  return label;
}

function completedKind(step: StreamStep, label: string): StreamStep["kind"] {
  if (step.kind) return step.kind;
  if (label === "Loaded examples") return "retrieval";
  if (label === "Composed answer") return "reasoning";
  if (label.includes("Agent") || label.includes("Analytics") || label.includes("Prediction") || label.includes("Genie")) {
    return "query";
  }
  return step.kind;
}

function isBroadStep(step: StreamStep) {
  const depth = step.depth ?? 0;
  if (depth > 0) return false;
  if (step.kind === "system") return false;
  return true;
}

function compactTimelineSteps(steps: StreamStep[], now: number): DisplayStep[] {
  const broad = steps.filter(isBroadStep);
  const source = broad.length ? broad : steps.filter((step) => step.kind !== "system");
  const compacted: DisplayStep[] = [];
  const groups = new Map<string, number>();
  let pendingReasoningMs = 0;

  const addStep = (step: StreamStep, durationMs: number) => {
    const label = completedLabel(step);
    const kind = completedKind(step, label);
    const key = `${kind ?? "step"}-${label}`;
    const existingIndex = groups.get(key);

    if (existingIndex != null) {
      const existing = compacted[existingIndex];
      compacted[existingIndex] = {
        ...existing,
        count: (existing.count ?? 1) + 1,
        durationMs: (existing.durationMs ?? stepDuration(existing, now)) + durationMs,
        endedAt: Math.max(existing.endedAt ?? existing.startedAt, step.endedAt ?? step.startedAt),
      };
      return;
    }

    groups.set(key, compacted.length);
    compacted.push({
      ...step,
      count: 1,
      detail: "",
      durationMs,
      depth: 0,
      kind,
      label,
      summary: "",
    });
  };

  for (const step of source) {
    const label = displayLabel(step);
    const duration = stepDuration(step, now);

    if (label === "Reasoning") {
      pendingReasoningMs += duration;
      continue;
    }

    addStep(step, duration + pendingReasoningMs);
    pendingReasoningMs = 0;
  }

  if (pendingReasoningMs > 0 && compacted.length) {
    const last = compacted[compacted.length - 1];
    compacted[compacted.length - 1] = {
      ...last,
      durationMs: (last.durationMs ?? stepDuration(last, now)) + pendingReasoningMs,
    };
  }

  return compacted;
}

function fallbackStep(status: StreamStatus | null, startedAt: number): StreamStep {
  const label = status?.activeAgent
    ? `Querying ${status.activeAgent}`
    : status?.message
      ? status.message.replace(/\.\.\.$/, "")
      : "Starting analysis";
  return {
    id: "fallback",
    label,
    detail: "",
    startedAt,
  };
}

function AnimatedStepText({ text }: { text: string }) {
  return (
    <span className="thinking-current-text" aria-label={text} key={text}>
      {text.split(" ").map((word, index) => (
        <span className="text-animate-word" key={`${word}-${index}`} style={{ animationDelay: `${index * 34}ms` }}>
          {word}
          {index < text.split(" ").length - 1 ? "\u00a0" : ""}
        </span>
      ))}
    </span>
  );
}

function Timeline({ now, steps }: { now: number; steps: StreamStep[] }) {
  const visibleSteps = compactTimelineSteps(steps, now);
  return (
    <div className="thinking-trace-tree">
      {visibleSteps.map((step, index) => {
        const active = !step.endedAt && index === visibleSteps.length - 1;
        const duration = formatStepDuration(step.durationMs ?? stepDuration(step, now), active);
        const primary = step.kind === "tool" || step.kind === "query";
        return (
          <div
            className={`thinking-trace-row ${active ? "active" : "done"} ${primary ? "primary" : ""} ${step.kind ?? "reasoning"}`}
            key={step.id}
          >
            <span className="thinking-trace-rail" aria-hidden="true" />
            <span className="thinking-trace-icon" aria-hidden="true">
              <StepIcon kind={step.kind} />
            </span>
            <span className="thinking-trace-copy">
              <span className="thinking-trace-line">
                <span className="thinking-trace-label">{step.label}</span>
                {step.count && step.count > 1 ? <span className="thinking-trace-count">{step.count} calls</span> : null}
                <time>{duration}</time>
              </span>
            </span>
            {active ? <span className="loader-dots" aria-hidden="true"><span /> <span /> <span /></span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function StreamingStatus({ complete = false, status }: { complete?: boolean; status: StreamStatus | null }) {
  const [now, setNow] = useState(Date.now());
  const [fallbackStartedAt] = useState(Date.now());

  useEffect(() => {
    if (complete) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [complete]);

  const steps = status?.steps?.length ? status.steps : [fallbackStep(status, fallbackStartedAt)];
  const totalDuration = timelineDuration(steps, now);
  const currentStep = steps[steps.length - 1];
  const elapsedThinkingTime = formatDuration(now - steps[0].startedAt);

  if (complete) {
    return (
      <details className="thinking-status complete">
        <summary>
          <span>Worked for</span>
          <time>{formatDuration(totalDuration)}</time>
          <CaretRight size={13} weight="bold" />
        </summary>
        <Timeline now={now} steps={steps} />
      </details>
    );
  }

  return (
    <div className="thinking-status">
      <div className="thinking-blob">
        <span className="thinking-label">Thinking</span>
        <AnimatedStepText text={displayLabel(currentStep)} />
        <span className="loader-dots" aria-hidden="true"><span /> <span /> <span /></span>
        <time>{elapsedThinkingTime}</time>
      </div>
    </div>
  );
}
