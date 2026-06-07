import { ArrowUp } from "@phosphor-icons/react";
import { useRef, useState } from "react";

type InputBarProps = {
  disabled: boolean;
  empty?: boolean;
  onSend: (text: string) => void;
};

export function InputBar({ disabled, empty = false, onSend }: InputBarProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
    onSend(text);
  };

  return (
    <form className={`input-wrap ${empty ? "empty" : ""}`} onSubmit={(event) => { event.preventDefault(); send(); }}>
      <textarea
        ref={ref}
        disabled={disabled}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onInput={(event) => {
          const target = event.currentTarget;
          target.style.height = "auto";
          target.style.height = `${Math.min(target.scrollHeight, 132)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        placeholder="Ask anything"
      />
      <button disabled={disabled || !value.trim()} type="submit" aria-label="Send message">
        <ArrowUp size={18} weight="bold" />
      </button>
    </form>
  );
}
