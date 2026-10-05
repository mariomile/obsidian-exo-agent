/**
 * Pure filter/grouping for the searchable select popover (model picker v2).
 * `view.ts` renders whatever this returns, so the query→visible-rows logic —
 * including group-header insertion and dropping headers whose group became
 * empty after filtering — is unit-testable without a DOM.
 */

import type { ProviderId } from "../providers/types";

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  risk?: string;
  /** Provider whose mark leads the row (model picker). */
  mark?: ProviderId;
}

export type OptionRow =
  | { kind: "header"; group: string }
  | { kind: "option"; option: SelectOption };

/** Case-insensitive substring match on label + value. Empty/whitespace query
 *  matches everything. */
export function matchesQuery(o: SelectOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
}

/**
 * Build the ordered render plan: options filtered by `query`, with a header row
 * emitted whenever a defined `group` first appears in source order. Groups left
 * with no visible options contribute no header (dropped automatically, since
 * headers are derived from surviving options). Options without a `group` never
 * emit a header — so non-grouped pickers are unaffected.
 */
export function buildOptionRows(options: SelectOption[], query: string): OptionRow[] {
  const rows: OptionRow[] = [];
  let lastGroup: string | undefined;
  for (const o of options) {
    if (!matchesQuery(o, query)) continue;
    if (o.group && o.group !== lastGroup) {
      rows.push({ kind: "header", group: o.group });
    }
    lastGroup = o.group;
    rows.push({ kind: "option", option: o });
  }
  return rows;
}

/** The visible options (no headers) for a query, in order — used for roving
 *  keyboard highlight bounds. */
export function visibleOptions(options: SelectOption[], query: string): SelectOption[] {
  return options.filter((o) => matchesQuery(o, query));
}
