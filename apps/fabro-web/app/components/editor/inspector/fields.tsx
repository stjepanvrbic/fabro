/**
 * Small field primitives for the inspector. Inputs hold their own draft and
 * commit on blur or Enter, so a keystroke never re-lays-out the canvas or
 * burns an undo step; the `key` on each field resets the draft when the
 * selection or the underlying value changes.
 */

import { useState } from "react";

import {
  FIELD_LABEL_CLASS,
  WELL_INPUT_CLASS,
  WELL_MONO_CLASS,
  WELL_SELECT_CLASS,
} from "../ui";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className={FIELD_LABEL_CLASS}>{label}</div>
      {children}
    </div>
  );
}

export function CommitInput({
  value,
  onCommit,
  mono = false,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  mono?: boolean;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      className={mono ? WELL_MONO_CLASS : WELL_INPUT_CLASS}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(value);
        }
        event.stopPropagation();
      }}
    />
  );
}

export function CommitTextarea({
  value,
  onCommit,
  rows = 6,
  placeholder,
  ariaLabel,
  textareaRef,
  onOpenPicker,
}: {
  value: string;
  onCommit: (next: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Called when "/" is typed at a word start (the skill picker trigger). */
  onOpenPicker?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <textarea
      ref={textareaRef}
      aria-label={ariaLabel}
      className={`${WELL_MONO_CLASS} resize-y`}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDraft(value);
        }
        if (
          event.key === "/" &&
          onOpenPicker &&
          wordStartBeforeCaret(event.currentTarget)
        ) {
          onOpenPicker();
        }
        event.stopPropagation();
      }}
    />
  );
}

function wordStartBeforeCaret(textarea: HTMLTextAreaElement): boolean {
  const caret = textarea.selectionStart ?? 0;
  if (caret === 0) return true;
  const before = textarea.value[caret - 1];
  return before === " " || before === "\n" || before === "\t";
}

export function CommitSelect({
  value,
  options,
  onCommit,
  ariaLabel,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onCommit: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={WELL_SELECT_CLASS}
      value={value}
      onChange={(event) => onCommit(event.target.value)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
