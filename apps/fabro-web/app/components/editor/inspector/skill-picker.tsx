/**
 * The skill picker: a filterable list of the operator's skills that inserts
 * a slash command at the prompt's caret. Opened by the button or by typing
 * "/" at a word start inside the prompt.
 */

import { useState } from "react";
import { CommandLineIcon } from "@heroicons/react/16/solid";

import type { EditorSkill } from "@qltysh/fabro-api-client";
import { WELL_INPUT_CLASS } from "../ui";

export default function SkillPicker({
  skills,
  open,
  onOpen,
  onClose,
  onPick,
}: {
  skills: readonly EditorSkill[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Receives the slash command to insert, e.g. `/tdd `. */
  onPick: (command: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const matches = skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(filter.toLowerCase()) ||
      skill.description.toLowerCase().includes(filter.toLowerCase()),
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={skills.length === 0}
        title={
          skills.length === 0
            ? "No skills discovered for this repo"
            : "Insert a skill as a slash command"
        }
        className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] font-medium text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
      >
        <CommandLineIcon className="size-3.5" />
        Insert skill
      </button>
    );
  }

  return (
    <div className="fac-card space-y-1 p-2">
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the picker opens on explicit request; focus belongs in the filter
        autoFocus
        type="text"
        aria-label="Filter skills"
        placeholder="Filter skills…"
        className={WELL_INPUT_CLASS}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          } else if (event.key === "Enter" && matches.length > 0) {
            onPick(`/${matches[0]!.name} `);
          }
          event.stopPropagation();
        }}
      />
      <ul
        className="max-h-48 space-y-0.5 overflow-auto"
        aria-label="Skills"
      >
        {matches.length === 0 && (
          <li className="px-2 py-1.5 text-[12px] text-fac-dim">
            No skill matches.
          </li>
        )}
        {matches.map((skill) => (
          <li key={skill.name}>
            <button
              type="button"
              onClick={() => onPick(`/${skill.name} `)}
              className="w-full rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-fac-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
            >
              <span className="font-mono text-[12px] text-fac-ink">
                /{skill.name}
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-fac-muted">
                {skill.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
