/**
 * "Forked from → <chat>" at the top of a forked chat (core/fork). Its own file
 * because `view.ts` is at its size ceiling. Plain text once the original is
 * gone, like the plan card's "Implemented in" link (ui/plan-handoff.ts).
 */
import type { ChatView } from "../view";
export { forkMessages } from "../core/fork";

export function renderForkedFrom(view: ChatView, list: HTMLElement, sourceId: string): void {
  const source = view.allConvos().find((c) => c.id === sourceId);
  const line = list.createDiv({ cls: "mva-faint mva-forked-from" });
  line.createSpan({ text: "Forked from " });
  // Restore can render a fork before its source is loaded: the link resolves
  // on click, and says so when the source is really gone.
  const link = line.createSpan({ cls: "mva-link", text: `→ ${source?.title || "the original chat"}` });
  link.addEventListener("click", () => {
    if (!view.openConvoById(sourceId)) link.setText("→ a chat that was deleted");
  });
}
