import { Brain, Package, Sparkle, Ticket, TrendDown } from "@phosphor-icons/react";
import type { Agent, AgentName } from "./types";

export const AGENTS: Agent[] = [
  { id: "churn", name: "Customer Churn Analytics", short: "Churn", icon: TrendDown },
  { id: "orders", name: "Order Cancellation Prediction", short: "Orders", icon: Package },
  { id: "recs", name: "Product Recommendation Genie", short: "Recs", icon: Sparkle },
  { id: "cases", name: "Customer Case Management", short: "Cases", icon: Ticket },
  { id: "intel", name: "Customer Intelligence Agent", short: "Intel", icon: Brain },
];

export function agentByName(name?: string | null) {
  return AGENTS.find((agent) => agent.name === name) ?? null;
}

export function isAgentName(value: string): value is AgentName {
  return AGENTS.some((agent) => agent.name === value);
}
