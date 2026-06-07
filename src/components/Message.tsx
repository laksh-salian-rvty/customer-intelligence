import { useState } from "react";
import { ArrowElbowDownRight, Check, Copy } from "@phosphor-icons/react";
import { MessageContent } from "./MessageContent";
import { StreamingStatus } from "./StreamingStatus";
import type { Message as MessageType } from "../types";

type MessageProps = {
  disabled?: boolean;
  message: MessageType;
  onFollowUp: (text: string) => void;
};

export function Message({ disabled = false, message, onFollowUp }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const copyMessage = async () => {
    if (!message.content.trim()) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`message ${isUser ? "user" : "assistant"}`} data-message-id={message.id} data-message-role={message.role}>
      <div className="message-bubble">
        {message.loading ? (
          <StreamingStatus status={message.streamStatus ?? null} />
        ) : isUser ? (
          <p>{message.content}</p>
        ) : (
          <>
            {message.streamStatus?.steps?.length ? <StreamingStatus complete status={message.streamStatus} /> : null}
            <MessageContent content={message.content} />
          </>
        )}
      </div>
      {!message.loading ? (
        <div className="message-actions">
          <button className="message-action-button" onClick={copyMessage} type="button" aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy"}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      ) : null}
      {!isUser && !message.loading && message.follow_ups?.length ? (
        <div className="follow-ups">
          <div className="follow-ups-heading">Suggested next questions</div>
          {message.follow_ups.slice(0, 4).map((followUp) => (
            <button key={followUp} disabled={disabled} onClick={() => onFollowUp(followUp)} type="button">
              <ArrowElbowDownRight size={14} weight="bold" />
              <strong>{followUp}</strong>
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
