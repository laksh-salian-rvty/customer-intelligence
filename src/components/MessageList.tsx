import { useEffect, useRef } from "react";
import { Message } from "./Message";
import type { Message as MessageType } from "../types";

function scrollMessageToTop(scrollParent: Element, messageElement: Element, behavior: ScrollBehavior) {
  const parentRect = scrollParent.getBoundingClientRect();
  const messageRect = messageElement.getBoundingClientRect();
  const top = scrollParent.scrollTop + messageRect.top - parentRect.top - 12;
  scrollParent.scrollTo({ top: Math.max(0, top), behavior });
}

function shouldScrollInitialThread(scrollParent: Element, messageElement: Element) {
  const overflow = scrollParent.scrollHeight - scrollParent.clientHeight;
  if (overflow <= 48) return false;

  const parentRect = scrollParent.getBoundingClientRect();
  const messageRect = messageElement.getBoundingClientRect();
  return messageRect.top - parentRect.top > 48;
}

function latestUserMessage(messages: MessageType[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return messages[messages.length - 1];
}

export function MessageList({ disabled = false, messages, onFollowUp }: { disabled?: boolean; messages: MessageType[]; onFollowUp: (text: string) => void }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const previousIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const scrollParent = listRef.current?.closest(".chat-scroll");
    const list = listRef.current;
    if (!scrollParent || !list || !messages.length) return;

    const previousIds = previousIdsRef.current;
    const currentIds = messages.map((message) => message.id);
    const isInitialThreadRender = !previousIds.length;
    const newUserMessage = messages.find(
      (message) => message.role === "user" && !previousIds.includes(message.id),
    );

    requestAnimationFrame(() => {
      if (isInitialThreadRender) {
        const targetMessage = latestUserMessage(messages);
        const target = list.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
        if (target && shouldScrollInitialThread(scrollParent, target)) scrollMessageToTop(scrollParent, target, "auto");
        return;
      }

      if (newUserMessage) {
        const target = list.querySelector(`[data-message-id="${CSS.escape(newUserMessage.id)}"]`);
        if (target) scrollMessageToTop(scrollParent, target, "smooth");
      }
    });

    previousIdsRef.current = currentIds;
  }, [messages]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.map((message) => <Message disabled={disabled} key={message.id} message={message} onFollowUp={onFollowUp} />)}
    </div>
  );
}
