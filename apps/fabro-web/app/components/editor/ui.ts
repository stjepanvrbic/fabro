/** Shared class constants for the editor's warm-charcoal surface. */

export const FIELD_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-fac-label";

export const WELL_INPUT_CLASS =
  "w-full rounded-[10px] border border-fac-line bg-fac-well px-2.5 py-1.5 " +
  "text-[13px] text-fac-ink placeholder:text-fac-dim " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/40";

export const WELL_MONO_CLASS = `${WELL_INPUT_CLASS} font-mono text-[12.5px] leading-relaxed`;

export const WELL_SELECT_CLASS = `${WELL_INPUT_CLASS} appearance-none pr-7`;

export const GHOST_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-fac-line-strong " +
  "bg-fac-hover px-3 py-1.5 text-[12px] font-medium text-fac-ink-2 transition-colors " +
  "hover:bg-fac-line-strong hover:text-fac-ink disabled:opacity-40 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-ink/60";

/** The go action: the one filled-green control on the surface. */
export const GO_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-[10px] bg-fac-go px-3.5 py-1.5 " +
  "text-[12.5px] font-semibold text-fac-on-go transition-opacity hover:opacity-90 " +
  "disabled:opacity-40 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-go";

export const DANGER_TEXT_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] font-medium " +
  "text-fac-red transition-colors hover:bg-fac-red-bg " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-red";
