import { useCallback, useRef, useState } from "react";
import {
  OPTIMISTIC_QUERY_DELAY_MS,
  OPTIMISTIC_ROUTE_DELAY_MS,
  appendStreamStep,
  closeOpenStreamSteps,
  createInitialStreamStatus,
  firstAgentDetail,
  firstAgentLabel,
  routingDetail,
} from "../streamingProgress";
import type { ChatDoneData, ChatSession, Message, StreamStep, TraceStep, TraceTurn } from "../types";

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function extractJsonObject(text: string, startIndex: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function cleanAssistantPayload(answer: string, followUps: string[] = []) {
  const candidates = [
    answer.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    answer.trim().startsWith("{") ? answer.trim() : null,
  ];
  const answerKeyIndex = answer.indexOf("\"answer\"");
  const objectStart = answerKeyIndex >= 0 ? answer.lastIndexOf("{", answerKeyIndex) : -1;
  if (objectStart >= 0) candidates.push(extractJsonObject(answer, objectStart));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
        return {
          answer: parsed.answer.trim(),
          followUps: Array.isArray(parsed.follow_ups) ? parsed.follow_ups.filter((item: unknown) => typeof item === "string") : followUps,
        };
      }
    } catch {
      // Fall back to the original answer if the embedded object is partial.
    }
  }

  return {
    answer: answer.replace(/```(?:json)?\s*\{[\s\S]*?"answer"[\s\S]*$/i, "").trim(),
    followUps,
  };
}

function stepId(label: string) {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
}

function withDuration(step: StreamStep, startedAt: number, durationMs: number): StreamStep {
  return {
    ...step,
    startedAt,
    endedAt: startedAt + Math.max(0, durationMs),
  };
}

function closeOpenSteps(steps: StreamStep[], endedAt: number) {
  return closeOpenStreamSteps(steps, endedAt);
}

function stringifyQuery(query: unknown) {
  if (!query) return "";
  if (typeof query === "string") return query;
  try {
    return JSON.stringify(query);
  } catch {
    return "";
  }
}

function timelineSearchText(source: TraceStep) {
  return `${source.agent ?? ""} ${source.content ?? ""} ${stringifyQuery(source.query)}`.toLowerCase();
}

function timelineLabel(source: TraceStep) {
  const rawAgent = (source.agent ?? "").toLowerCase();
  const search = timelineSearchText(source);

  if (source.label && source.label !== "Reasoning over results") return source.label;
  if (search.includes("example")) return "Loading examples";
  if (rawAgent.includes("llm")) return "Reasoning";
  if (search.includes("churn") || search.includes("retention") || search.includes("at-risk") || search.includes("at risk")) {
    return "Querying Customer Churn Analytics";
  }
  if (search.includes("cancellation") || search.includes("cancel") || search.includes("order risk")) {
    return "Querying Order Cancellation Prediction";
  }
  if (search.includes("recommend") || search.includes("cross-sell") || search.includes("upsell") || search.includes("product")) {
    return "Querying Product Recommendation Genie";
  }
  if (search.includes("case") || search.includes("support") || search.includes("ticket") || search.includes("complaint")) {
    return "Querying Customer Case Management";
  }
  if (
    search.includes("intelligence") ||
    search.includes("contract") ||
    search.includes("entitlement") ||
    search.includes("work order") ||
    search.includes("asset") ||
    search.includes("quote") ||
    search.includes("service history") ||
    search.includes("field service") ||
    search.includes("summary") ||
    rawAgent.includes("genie")
  ) {
    return "Querying Customer Intelligence Agent";
  }
  if (rawAgent.includes("supervisor")) return "Composing answer";

  return source.agent ? `Querying ${source.agent}` : "Working";
}

function timelineWeight(source: TraceStep, label: string) {
  if (typeof source.weight === "number" && Number.isFinite(source.weight) && source.weight > 0) {
    return source.weight;
  }

  const search = `${timelineSearchText(source)} ${label.toLowerCase()}`;
  if (search.includes("example")) return 1;
  if (search.includes("llm") || search.includes("reasoning") || search.includes("composing")) return 3;
  if (search.includes("genie") || search.includes("agent-") || search.includes("querying")) return 12;
  return 6;
}

function durationFromSource(source: TraceStep) {
  return typeof source.duration_ms === "number" && Number.isFinite(source.duration_ms) && source.duration_ms > 0
    ? source.duration_ms
    : null;
}

function startOffsetFromSource(source: TraceStep) {
  return typeof source.start_offset_ms === "number" && Number.isFinite(source.start_offset_ms) && source.start_offset_ms >= 0
    ? source.start_offset_ms
    : null;
}

function traceSources(finalData: ChatDoneData) {
  const timeline = finalData.timeline?.filter((step) => step.type === "call" || step.type === "supervisor_final") ?? [];
  const trace = finalData.trace?.filter((step) => step.type === "call" || step.type === "supervisor_final") ?? [];
  if (timeline.length) {
    return timeline.map((step, index) => ({
      ...(trace[index] ?? {}),
      ...step,
      query: step.query ?? trace[index]?.query,
    }));
  }
  return trace;
}

function buildCompletedStepsFromTrace(finalData: ChatDoneData, fallbackSteps: StreamStep[], finishedAt: number) {
  const sources = traceSources(finalData);
  if (!sources.length) return null;

  const startedAt = fallbackSteps[0]?.startedAt ?? finishedAt;
  const wallMs = Math.max(1_000, finishedAt - startedAt);
  const normalized = sources.map((source) => ({
    source,
    label: timelineLabel(source),
    durationMs: durationFromSource(source),
    startOffsetMs: startOffsetFromSource(source),
    weight: timelineWeight(source, timelineLabel(source)),
  }));

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if ((normalized[index].source.agent ?? "").toLowerCase().includes("llm")) {
      normalized[index] = {
        ...normalized[index],
        label: "Composing answer",
        weight: Math.max(normalized[index].weight, 4),
      };
      break;
    }
  }

  const knownDuration = normalized.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const missing = normalized.filter((item) => item.durationMs == null);
  const missingWeight = missing.reduce((sum, item) => sum + item.weight, 0);
  const fallbackBudget = knownDuration > 0 ? Math.max(0, wallMs - knownDuration) : wallMs;
  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0);

  const hasOffsets = normalized.some((item) => item.startOffsetMs != null && item.durationMs != null);
  if (hasOffsets) {
    const traceWallMs = Math.max(
      1_000,
      ...normalized.map((item) => (item.startOffsetMs ?? 0) + (item.durationMs ?? 1_000)),
    );
    const traceStartedAt = finishedAt - traceWallMs;
    let cursorOffset = 0;
    return normalized
      .map((item, index) => {
        const duration = item.durationMs
          ?? (knownDuration > 0
            ? fallbackBudget * (item.weight / Math.max(1, missingWeight))
            : wallMs * (item.weight / Math.max(1, totalWeight)));
        const offset = item.startOffsetMs ?? cursorOffset;
        cursorOffset = Math.max(cursorOffset, offset + duration);
        return {
          id: stepId(`${item.label}-${index}`),
          label: item.label,
          detail: item.source.summary ?? "",
          startedAt: traceStartedAt + offset,
          endedAt: traceStartedAt + offset + duration,
          kind: item.source.kind,
          depth: item.source.depth,
          summary: item.source.summary,
          agent: item.source.agent,
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  let cursor = startedAt;
  return normalized.map((item, index) => {
    const duration = item.durationMs
      ?? (knownDuration > 0
        ? fallbackBudget * (item.weight / Math.max(1, missingWeight))
        : wallMs * (item.weight / Math.max(1, totalWeight)));
    const started = cursor;
    cursor += duration;
    return {
      id: stepId(`${item.label}-${index}`),
      label: item.label,
      detail: item.source.summary ?? "",
      startedAt: started,
      endedAt: cursor,
      kind: item.source.kind,
      depth: item.source.depth,
      summary: item.source.summary,
      agent: item.source.agent,
    };
  });
}

function rebalanceCompletedSteps(steps: StreamStep[], finishedAt: number) {
  const closed = closeOpenSteps(steps, finishedAt);
  if (!closed.length) return closed;

  const startedAt = closed[0].startedAt;
  const totalMs = Math.max(0, finishedAt - startedAt);
  if (totalMs < 2_500) return closed;

  const analysis = closed.find((step) => step.label === "Analyzing request") ?? closed[0];
  const routing = closed.find((step) => step.label === "Selecting specialist");
  const querySteps = closed.filter((step) => step.label.startsWith("Querying "));

  const analysisMs = Math.min(Math.max((analysis.endedAt ?? finishedAt) - analysis.startedAt, 300), 1_200);
  const routingMs = routing ? Math.min(Math.max((routing.endedAt ?? finishedAt) - routing.startedAt, 300), 1_200) : 0;
  const minQueryMs = querySteps.length ? Math.min(1_000, totalMs * 0.25) : 0;
  const maxComposeMs = Math.max(0, totalMs - analysisMs - routingMs - minQueryMs);
  const composeMs = Math.min(Math.max(totalMs * 0.34, 2_000), Math.max(2_000, totalMs * 0.45), maxComposeMs);
  const queryBudget = Math.max(0, totalMs - analysisMs - routingMs - composeMs);
  const queryRawTotal = querySteps.reduce((sum, step) => sum + Math.max(1, (step.endedAt ?? finishedAt) - step.startedAt), 0);

  let cursor = startedAt;
  const balanced: StreamStep[] = [];
  balanced.push(withDuration(analysis, cursor, analysisMs));
  cursor += analysisMs;

  if (routing) {
    balanced.push(withDuration(routing, cursor, routingMs));
    cursor += routingMs;
  }

  if (querySteps.length) {
    querySteps.forEach((step, index) => {
      const raw = Math.max(1, (step.endedAt ?? finishedAt) - step.startedAt);
      const duration = index === querySteps.length - 1
        ? Math.max(0, startedAt + totalMs - composeMs - cursor)
        : queryBudget * (raw / queryRawTotal);
      balanced.push(withDuration(step, cursor, duration));
      cursor += duration;
    });
  }

  balanced.push({
    id: stepId("compose"),
    label: "Composing answer",
    detail: "Preparing the final response for display.",
    startedAt: cursor,
    endedAt: startedAt + totalMs,
  });

  return balanced;
}

export function useChat(session: ChatSession, updateSession: (sessionId: string, messages: Message[], traces?: TraceTurn[]) => void) {
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});
  const loadingRef = useRef<Record<string, boolean>>({});

  const setSessionLoading = useCallback((sessionId: string, loading: boolean) => {
    loadingRef.current = { ...loadingRef.current, [sessionId]: loading };
    setLoadingSessions((current) => ({ ...current, [sessionId]: loading }));
  }, []);

  const send = useCallback(async (text: string) => {
    const userText = text.trim();
    const sessionId = session.id;
    const sessionTraces = session.traces;
    if (!userText || loadingRef.current[sessionId]) return;
    setSessionLoading(sessionId, true);

    const initialStreamStatus = createInitialStreamStatus(userText);
    let steps: StreamStep[] = initialStreamStatus.steps ?? [];
    let agents: string[] = initialStreamStatus.agents ?? [];
    let finalData: ChatDoneData | null = null;
    let errorMessage: string | null = null;
    let activeStepKey = "client-analyze";
    const progressTimers: ReturnType<typeof window.setTimeout>[] = [];
    const userMessage: Message = { id: id("message"), role: "user", content: userText };
    const loadingMessage: Message = {
      id: id("message"),
      role: "assistant",
      content: "",
      loading: true,
      streamStatus: initialStreamStatus,
    };
    const baseMessages = session.messages
      .filter((message) => !message.loading)
      .map((message) => message.role === "assistant" ? { ...message, follow_ups: [] } : message);
    const optimistic = [...baseMessages, userMessage, loadingMessage];
    updateSession(sessionId, optimistic, sessionTraces);

    const replaceLoading = (message: Message) => {
      updateSession(sessionId, [...baseMessages, userMessage, message], sessionTraces);
    };

    const startStep = (key: string, label: string, detail: string, kind?: StreamStep["kind"]) => {
      const now = Date.now();
      if (activeStepKey === key) return steps;
      const nextSteps = appendStreamStep(steps, key, label, detail, now, kind);
      if (nextSteps === steps) {
        activeStepKey = key;
        return steps;
      }
      steps = nextSteps;
      activeStepKey = key;
      return steps;
    };

    const hasStep = (label: string) => steps.some((step) => step.label === label);

    const updateOptimisticProgress = (key: string, label: string, detail: string, message: string, activeAgent: string | null, kind: StreamStep["kind"]) => {
      if (finalData || errorMessage) return;
      const nextSteps = startStep(key, label, detail, kind);
      replaceLoading({
        ...loadingMessage,
        streamStatus: {
          message,
          agents,
          activeAgent,
          completedAgents: [],
          steps: nextSteps,
        },
      });
    };

    progressTimers.push(window.setTimeout(() => {
      updateOptimisticProgress(
        "client-route",
        "Selecting specialist",
        routingDetail(agents),
        "Dispatching to agents...",
        null,
        "system",
      );
    }, OPTIMISTIC_ROUTE_DELAY_MS));

    progressTimers.push(window.setTimeout(() => {
      const activeAgent = agents[0] ?? null;
      updateOptimisticProgress(
        "client-query",
        firstAgentLabel(agents),
        firstAgentDetail(activeAgent),
        activeAgent ? `Querying ${activeAgent}...` : "Querying specialist...",
        activeAgent,
        "query",
      );
    }, OPTIMISTIC_QUERY_DELAY_MS));

    try {
      const history = baseMessages.map((message) => ({ role: message.role, content: message.content }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: userText }] }),
      });

      if (!response.ok || !response.body) {
        const body = await response.text();
        throw new Error(`Server error (${response.status}): ${body.slice(0, 160)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "status") {
            const isCompiling = typeof event.message === "string" && event.message.toLowerCase().includes("compiling");
            const nextSteps = isCompiling
              ? steps
              : hasStep("Analyzing request")
                ? steps
                : startStep("analyze", "Analyzing request", "Reading your message and preparing the route through the available specialists.");
            replaceLoading({ ...loadingMessage, streamStatus: { message: event.message, agents, activeAgent: null, completedAgents: isCompiling ? agents : [], steps: nextSteps } });
          }
          if (event.type === "routing") {
            agents = event.agents ?? [];
            const nextSteps = hasStep("Selecting specialist")
              ? steps
              : startStep("route", "Selecting specialist", routingDetail(agents));
            replaceLoading({ ...loadingMessage, streamStatus: { message: "Dispatching to agents...", agents, activeAgent: agents[0] ?? null, completedAgents: [], steps: nextSteps } });
          }
          if (event.type === "live_step") {
            const label = typeof event.label === "string" && event.label.trim() ? event.label : "Working";
            const key = typeof event.key === "string" && event.key.trim() ? event.key : label;
            const detail = typeof event.detail === "string" ? event.detail : "";
            const nextSteps = startStep(`live-${key}`, label, detail);
            steps = nextSteps.map((step, index) => index === nextSteps.length - 1
              ? { ...step, kind: event.kind }
              : step);
            replaceLoading({ ...loadingMessage, streamStatus: { message: label, agents, activeAgent: label, completedAgents: [], steps } });
          }
          if (event.type === "agent_progress") {
            const completedAgents = agents.slice(0, agents.indexOf(event.agent));
            const nextSteps = startStep(`agent-${event.agent}`, `Querying ${event.agent}`, firstAgentDetail(event.agent));
            replaceLoading({ ...loadingMessage, streamStatus: { agents, activeAgent: event.agent, completedAgents, steps: nextSteps } });
          }
          if (event.type === "done") {
            const now = Date.now();
            steps = closeOpenSteps(steps, now);
            activeStepKey = "compose";
            finalData = event.data;
          }
          if (event.type === "error") errorMessage = event.message;
        }
      }

      if (errorMessage) throw new Error(errorMessage);
      if (!finalData) throw new Error("No response received from agent.");

      const cleaned = cleanAssistantPayload(finalData.answer || "No response.", finalData.follow_ups ?? []);
      const finishedAt = Date.now();
      const completedSteps = buildCompletedStepsFromTrace(finalData, steps, finishedAt) ?? rebalanceCompletedSteps(steps, finishedAt);
      const assistantMessage: Message = {
        id: id("message"),
        role: "assistant",
        content: cleaned.answer || "No response.",
        routing: finalData.routing ?? null,
        follow_ups: cleaned.followUps,
        streamStatus: completedSteps.length ? { steps: completedSteps } : null,
      };
      const nextTraces = finalData.trace
        ? sessionTraces.concat({ id: id("trace"), query: userText, trace: finalData.trace })
        : sessionTraces;
      updateSession(sessionId, [...baseMessages, userMessage, assistantMessage], nextTraces);
    } catch (error) {
      const assistantMessage: Message = {
        id: id("message"),
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
      updateSession(sessionId, [...baseMessages, userMessage, assistantMessage], sessionTraces);
    } finally {
      progressTimers.forEach((timer) => window.clearTimeout(timer));
      setSessionLoading(sessionId, false);
    }
  }, [session.id, session.messages, session.traces, setSessionLoading, updateSession]);

  return {
    loading: Boolean(loadingSessions[session.id]),
    messages: session.messages,
    send,
    traces: session.traces,
  };
}
