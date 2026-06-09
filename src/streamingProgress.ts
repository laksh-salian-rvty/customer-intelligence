import type { AgentName, StreamStatus, StreamStep, TraceStep } from "./types";

const AGENT_KEYWORDS: Record<AgentName, string[]> = {
  "Customer Churn Analytics": ["churn", "retention", "at-risk", "at risk", "loyalty", "health score", "segment", "cohort", "lifetime value", "clv", "churn risk"],
  "Order Cancellation Prediction": ["order", "cancel", "cancellation", "shipment", "delivery", "order status", "order risk", "order trend"],
  "Product Recommendation Genie": ["recommend", "similar", "cross-sell", "upsell", "product suggestion", "what else", "alternative", "suggestion"],
  "Customer Case Management": ["case", "ticket", "support", "complaint", "issue", "resolution", "escalat", "priority", "sentiment"],
  "Customer Intelligence Agent": ["work order", "asset", "contract", "entitlement", "quote", "service history", "field service", "sla", "warranty"],
};

const BROAD_QUERY_TERMS = ["overall", "summary", "everything", "360", "full picture", "complete", "all about"];

export const OPTIMISTIC_ROUTE_DELAY_MS = 700;
export const OPTIMISTIC_QUERY_DELAY_MS = 1_600;

export function predictProgressAgents(query: string): AgentName[] {
  const normalized = query.toLowerCase();
  const matched = Object.entries(AGENT_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))
    .map(([agent]) => agent as AgentName);

  if (BROAD_QUERY_TERMS.some((term) => normalized.includes(term))) {
    return Object.keys(AGENT_KEYWORDS) as AgentName[];
  }

  return matched.length ? matched : ["Customer Intelligence Agent"];
}

export function streamStepId(key: string, startedAt: number) {
  return `${key}-${Math.round(startedAt)}`;
}

export function createStreamStep(
  key: string,
  label: string,
  detail: string,
  startedAt: number,
  kind?: TraceStep["kind"],
): StreamStep {
  return {
    id: streamStepId(key, startedAt),
    label,
    detail,
    startedAt,
    kind,
  };
}

export function createInitialStreamStatus(query: string, startedAt = Date.now()): StreamStatus {
  const agents = predictProgressAgents(query);
  return {
    message: "Analyzing your query...",
    agents,
    activeAgent: null,
    completedAgents: [],
    steps: [
      createStreamStep(
        "client-analyze",
        "Analyzing request",
        "Reading your message and preparing the route through the available specialists.",
        startedAt,
        "reasoning",
      ),
    ],
  };
}

export function closeOpenStreamSteps(steps: StreamStep[], endedAt: number) {
  return steps.map((step, index) => index === steps.length - 1 && !step.endedAt ? { ...step, endedAt } : step);
}

export function appendStreamStep(
  steps: StreamStep[],
  key: string,
  label: string,
  detail: string,
  startedAt: number,
  kind?: TraceStep["kind"],
) {
  const lastStep = steps[steps.length - 1];
  if (lastStep && !lastStep.endedAt && lastStep.label === label) {
    return steps;
  }
  return closeOpenStreamSteps(steps, startedAt).concat(createStreamStep(key, label, detail, startedAt, kind));
}

export function routingDetail(agents: string[]) {
  return agents.length
    ? `Routing this request to ${agents.join(", ")}.`
    : "Choosing the best available specialist for this request.";
}

export function firstAgentLabel(agents: string[]) {
  return agents[0] ? `Querying ${agents[0]}` : "Querying specialist";
}

export function firstAgentDetail(agent?: string | null) {
  return agent
    ? `Waiting for ${agent} to retrieve, analyze, and return the relevant data.`
    : "Waiting for the selected specialist to retrieve, analyze, and return the relevant data.";
}
