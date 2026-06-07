import { useCallback, useEffect, useRef } from "react";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";
import { Welcome } from "./Welcome";
import type { Message } from "../types";

type ChatViewProps = {
  loading: boolean;
  messages: Message[];
  onScrollStateChange: (scrolled: boolean) => void;
  onSend: (text: string) => void;
  threadKey: string;
};

export function ChatView({ loading, messages, onScrollStateChange, onSend, threadKey }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const empty = !messages.length;
  const updateScrollState = useCallback((scrollElement: HTMLDivElement | null) => {
    onScrollStateChange(Boolean(scrollElement && scrollElement.scrollTop > 0));
  }, [onScrollStateChange]);

  useEffect(() => {
    updateScrollState(scrollRef.current);
    const frame = requestAnimationFrame(() => updateScrollState(scrollRef.current));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, threadKey, updateScrollState]);

  return (
    <main className={`chat-view ${empty ? "empty" : ""}`}>
      <div className="chat-scroll" onScroll={(event) => updateScrollState(event.currentTarget)} ref={scrollRef}>
        {empty ? <Welcome onSuggestionClick={onSend} /> : <MessageList disabled={loading} key={threadKey} messages={messages} onFollowUp={onSend} />}
      </div>
      <InputBar disabled={loading} empty={empty} onSend={onSend} />
    </main>
  );
}
