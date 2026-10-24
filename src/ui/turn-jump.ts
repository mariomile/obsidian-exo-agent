/**
 * Jumping to a turn in a drawn transcript: the outline's ticks, a recalled
 * chat, an `exo-chat` link. Out of `view.ts` (size ceiling) and out of
 * `ui/reentry.ts`, which by contract never reads the viewport.
 */
import { anchorTurn } from "./reentry";

/** Smooth-scroll a turn to near the top and flash it briefly. Instant scroll
 *  and no motion when reduced motion is requested. */
export function jumpToTurn(turn: HTMLElement, reduce: boolean): void {
  turn.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  turn.removeClass("is-flash");
  void turn.offsetWidth; // restart the fade if the same turn is clicked twice
  turn.addClass("is-flash");
  window.setTimeout(() => turn.removeClass("is-flash"), 1000);
}

/** Bring message `index` into view. False when no element renders it. */
export function revealMessage(listEl: HTMLElement, index: number): boolean {
  const turn = anchorTurn(listEl, index);
  if (!turn) return false;
  jumpToTurn(turn, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  return true;
}
