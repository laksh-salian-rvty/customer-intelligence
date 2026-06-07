import { ArrowElbowDownRight } from "@phosphor-icons/react";

const SUGGESTIONS = [
  "Which customers are at highest churn risk this month?",
  "Predict cancellation probability for recent orders",
  "Recommend products for customers who bought LabChip",
  "Show open support cases for VIP customers",
  "List active contracts and entitlements expiring this quarter",
];

export function Welcome({ onSuggestionClick }: { onSuggestionClick: (text: string) => void }) {
  return (
    <section className="welcome">
      <h1>Where should we begin?</h1>
      <div className="suggestion-panel" aria-label="Suggested prompts">
        <div className="suggestion-panel-surface">
          <div className="suggestion-list">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} onClick={() => onSuggestionClick(suggestion)} type="button">
            <ArrowElbowDownRight size={15} weight="bold" />
            <strong>{suggestion}</strong>
          </button>
        ))}
          </div>
        </div>
      </div>
    </section>
  );
}
