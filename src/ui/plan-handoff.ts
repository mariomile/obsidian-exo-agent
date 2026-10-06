/**
 * "Build in new chat" on the plan card, from T3 Code's "Implement in new
 * thread": the approved plan becomes the first message of a fresh chat, the
 * planning chat stops there, and its card links to where the plan went. Its own
 * file because `view.ts` is at its size ceiling.
 */
import type { ChatView } from "../view";
import type { Segment } from "../core/model";
import { planHandoffPrompt, PLAN_HANDOFF_DENY } from "../core/plan";

type PlanSegment = Extract<Segment, { t: "plan" }>;

/** How long a settled card keeps following its new chat's title: the AI
 *  title's own ceiling (main.ts generateTitle, 90s). */
const TITLE_FOLLOW_MS = 90_000;

export function addBuildInNewChat(
  view: ChatView,
  actions: HTMLElement,
  seg: PlanSegment,
  leavePlanMode: () => void,
  finish: (approved: boolean, d: { behavior: "deny"; message: string }) => void,
): void {
  actions.createEl("button", { cls: "mva-btn", text: "Build in new chat" }).onclick = () => {
    // Out of plan mode first: the new chat takes its mode from the settings.
    leavePlanMode();
    const id = view.askInNewConversation(planHandoffPrompt(seg.md));
    if (!id) return;
    seg.implementedIn = id;
    finish(true, { behavior: "deny", message: PLAN_HANDOFF_DENY });
  };
}

/** "Implemented in → <chat>" on a settled plan card; plain text once that chat
 *  is gone. */
export function renderImplementedLink(view: ChatView, head: HTMLElement, id: string): void {
  const target = view.allConvos().find((c) => c.id === id);
  const link = head.createSpan({ cls: "mva-plan-state", text: `→ ${target?.title || "a chat that was deleted"}` });
  if (!target) return;
  // The new chat is still "New chat" when the card settles: its real title
  // lands seconds later (seen live). Follow it for as long as a title can take.
  const started = Date.now();
  const follow = window.setInterval(() => {
    if (!link.isConnected || Date.now() - started > TITLE_FOLLOW_MS) return window.clearInterval(follow);
    link.setText(`→ ${target.title}`);
  }, 2000);
  link.addClass("mva-link");
  link.addEventListener("click", (e) => {
    e.stopPropagation(); // the head toggles the card
    view.openConvoById(id);
  });
}
