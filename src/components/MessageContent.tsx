import type { ReactNode } from "react";

function isTableSeparator(line: string) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function splitTableRow(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isBlockStart(line: string) {
  return line.startsWith("```") || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^---+$/.test(line);
}

function looksLikePlainListItem(line: string) {
  const words = line.trim().split(/\s+/);
  if (words.length < 3 || words.length > 14) return false;
  if (/[.!?]$/.test(line.trim())) return false;
  if (line.includes(":")) return true;
  return /^(Analyzing|Reviewing|Generating|Examining|Querying|Identifying|Finding|Showing|Listing|Predicting|Recommending|Summarizing|Comparing|Tracking|Checking|Creating|Building)\b/i.test(line.trim());
}

function looksLikeSectionHeading(line: string) {
  const cleaned = line.trim().replace(/\*\*/g, "");
  if (cleaned.length > 80) return false;
  if (/^[A-Z][A-Z0-9\s/&,-]+:$/.test(cleaned)) return true;
  return /^[A-Z][\w\s/&,-]{3,}:$/.test(cleaned) && cleaned.split(/\s+/).length <= 7;
}

function isBoldListLabel(item: string) {
  return /^\*\*[^*\n]+:\*\*$/.test(item.trim());
}

function stripSupervisorEnvelope(content: string) {
  const fenced = content.match(/```(?:json)?\s*({[\s\S]*?"answer"[\s\S]*?})\s*```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (typeof parsed.answer === "string") return parsed.answer.trim();
    } catch {
      return content.replace(fenced[0], "").trim();
    }
  }

  return content.replace(/```(?:json)?\s*\{[\s\S]*?"answer"[\s\S]*$/i, "").trim();
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|(https?:\/\/[^\s)]+))/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const key = `${match.index}-${match[0]}`;

    if (match[2] !== undefined && match[3]) {
      parts.push(<img className="inline-message-image" src={match[3]} alt={match[2]} key={key} />);
    } else if (match[4] !== undefined && match[5]) {
      parts.push(<a href={match[5]} key={key} rel="noreferrer" target="_blank">{match[4]}</a>);
    } else if (match[6] !== undefined) {
      parts.push(<code key={key}>{match[6]}</code>);
    } else if (match[7] !== undefined) {
      parts.push(<strong key={key}>{match[7]}</strong>);
    } else if (match[8] !== undefined) {
      parts.push(<em key={key}>{match[8]}</em>);
    } else if (match[9] !== undefined) {
      parts.push(<a href={match[9]} key={key} rel="noreferrer" target="_blank">{match[9]}</a>);
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function MessageContent({ content }: { content: string }) {
  const lines = stripSupervisorEnvelope(content).split("\n");
  const elements: ReactNode[] = [];
  let index = 0;

  const pushParagraph = (paragraphLines: string[], key: string) => {
    const text = paragraphLines.join(" ").trim();
    if (text) elements.push(<p key={key}>{renderInline(text)}</p>);
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const closingIndex = lines.findIndex((candidate: string, candidateIndex: number) => candidateIndex > index && candidate.trim().startsWith("```"));
      if (closingIndex === -1) {
        index += 1;
        continue;
      }
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      elements.push(
        <pre key={`code-${index}`}><code className={language ? `language-${language}` : undefined}>{code.join("\n")}</code></pre>,
      );
      continue;
    }

    const imageOnly = trimmed.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (imageOnly) {
      elements.push(<img className="message-image" src={imageOnly[2]} alt={imageOnly[1]} key={`image-${index}`} />);
      index += 1;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      elements.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      elements.push(<h3 key={`h3-${index}`}>{renderInline(trimmed.slice(4))}</h3>);
      index += 1;
      continue;
    }

    if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      elements.push(<h2 key={`h2-${index}`}>{renderInline(trimmed.replace(/^#{1,2}\s+/, ""))}</h2>);
      index += 1;
      continue;
    }

    if (looksLikeSectionHeading(trimmed)) {
      elements.push(<h2 key={`section-${index}`}>{renderInline(trimmed.replace(/\*\*/g, "").replace(/:$/, ""))}</h2>);
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      elements.push(<blockquote key={`quote-${index}`}>{renderInline(quote.join(" "))}</blockquote>);
      continue;
    }

    if (trimmed.startsWith("|") && lines[index + 1] && isTableSeparator(lines[index + 1])) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const headers = splitTableRow(tableLines[0] ?? "");
      const rows = tableLines.slice(2).map(splitTableRow).filter((row) => row.some(Boolean));
      elements.push(
        <div className="table-scroll" key={`table-${index}`}>
          <table>
            <thead><tr>{headers.map((header, headerIndex) => <th key={`${header}-${headerIndex}`}>{renderInline(header)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{renderInline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)/);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*+]\s+(.*)/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      if (items.length > 1 && isBoldListLabel(items[0])) {
        elements.push(<p className="list-lead" key={`list-lead-${index}`}>{renderInline(items[0])}</p>);
        elements.push(<ul key={`ul-${index}`}>{items.slice(1).map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>);
        continue;
      }
      elements.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)/);
    if (numbered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+\.\s+(.*)/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      elements.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>);
      continue;
    }

    if (looksLikePlainListItem(trimmed) && index > 0 && lines[index - 1].trim().endsWith(":")) {
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current || isBlockStart(current) || !looksLikePlainListItem(current)) break;
        items.push(current);
        index += 1;
      }
      if (items.length > 1) {
        elements.push(<ul className="plain-inferred-list" key={`plain-ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>);
        continue;
      }
      index -= items.length;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current || isBlockStart(current)) break;
      paragraph.push(current);
      index += 1;
    }
    pushParagraph(paragraph, `p-${index}`);
  }

  return <div className="message-content">{elements}</div>;
}
