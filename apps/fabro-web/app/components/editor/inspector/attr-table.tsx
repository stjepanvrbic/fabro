/**
 * Generic attribute table — the escape hatch that keeps the editor fully
 * generic: any attribute the workflow language grows is editable here
 * without a bespoke field. Values type themselves the way the parser does:
 * integers, floats, and true/false become typed values, everything else
 * stays a string.
 */

import { useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/16/solid";

import type { AttrValue } from "../model/graph";
import { FIELD_LABEL_CLASS, WELL_MONO_CLASS } from "../ui";
import { CommitInput } from "./fields";

export function coerceAttrValue(raw: string): AttrValue {
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

export function formatAttrValue(value: AttrValue): string {
  return typeof value === "string" ? value : String(value);
}

export default function AttrTable({
  label,
  attrs,
  /** Keys owned by named fields above the table; hidden here. */
  omit = [],
  onSet,
  onRemove,
}: {
  label: string;
  attrs: Record<string, AttrValue>;
  omit?: readonly string[];
  onSet: (key: string, value: AttrValue) => void;
  onRemove: (key: string) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const entries = Object.entries(attrs).filter(([key]) => !omit.includes(key));

  const addAttr = () => {
    const key = newKey.trim();
    if (!key) return;
    onSet(key, coerceAttrValue(newValue));
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="space-y-1.5">
      <div className={FIELD_LABEL_CLASS}>{label}</div>
      {entries.length === 0 && (
        <p className="text-[12px] text-fac-dim">No other attributes.</p>
      )}
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-1.5">
          <span
            className="w-2/5 shrink-0 truncate pt-1.5 font-mono text-[12px] text-fac-muted"
            title={key}
          >
            {key}
          </span>
          <CommitInput
            key={`${key}=${formatAttrValue(value)}`}
            ariaLabel={`Value of ${key}`}
            mono
            value={formatAttrValue(value)}
            onCommit={(next) => onSet(key, coerceAttrValue(next))}
          />
          <button
            type="button"
            aria-label={`Remove ${key}`}
            onClick={() => onRemove(key)}
            className="mt-1 flex size-6 shrink-0 items-center justify-center rounded text-fac-dim transition-colors hover:bg-fac-hover hover:text-fac-red focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
          >
            <XMarkIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-0.5">
        <input
          type="text"
          aria-label="New attribute key"
          placeholder="attribute"
          className={`${WELL_MONO_CLASS} w-2/5 shrink-0`}
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addAttr();
            event.stopPropagation();
          }}
        />
        <input
          type="text"
          aria-label="New attribute value"
          placeholder="value"
          className={WELL_MONO_CLASS}
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addAttr();
            event.stopPropagation();
          }}
        />
        <button
          type="button"
          aria-label="Add attribute"
          onClick={addAttr}
          disabled={newKey.trim().length === 0}
          className="flex size-6 shrink-0 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
