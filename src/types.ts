import type { Icon } from "@phosphor-icons/react";

export type ViewMode = "chat" | "dashboard";
export type Role = "user" | "assistant";

export type AgentName =
  | "Customer Churn Analytics"
  | "Order Cancellation Prediction"
  | "Product Recommendation Genie"
  | "Customer Case Management"
  | "Customer Intelligence Agent";

export type Agent = {
  id: string;
  name: AgentName;
  short: string;
  icon: Icon;
};

export type TraceStep = {
  type: "call" | "response" | "supervisor_final" | string;
  agent: string;
  query?: unknown;
  content?: string;
  duration_ms?: number;
  start_offset_ms?: number;
  label?: string;
  weight?: number;
  kind?: "reasoning" | "tool" | "query" | "retrieval" | "system";
  depth?: number;
  summary?: string;
  span_id?: string;
  parent_span_id?: string | null;
};

export type TraceTurn = {
  id: string;
  query: string;
  trace: TraceStep[];
};

export type Routing = {
  selected_agent?: AgentName;
  reasoning?: string;
  confidence?: number;
  alternatives?: AgentName[];
} | null;

export type StreamStatus = {
  message?: string | null;
  agents?: string[];
  activeAgent?: string | null;
  completedAgents?: string[];
  steps?: StreamStep[];
};

export type StreamStep = {
  id: string;
  label: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
  kind?: TraceStep["kind"];
  depth?: number;
  summary?: string;
  agent?: string;
};

export type Message = {
  id: string;
  role: Role;
  content: string;
  loading?: boolean;
  routing?: Routing;
  follow_ups?: string[];
  streamStatus?: StreamStatus | null;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  traces: TraceTurn[];
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
};

export type ChatDoneData = {
  answer: string;
  routing?: Routing;
  trace?: TraceStep[];
  timeline?: TraceStep[];
  trace_id?: string;
  follow_ups?: string[];
};
