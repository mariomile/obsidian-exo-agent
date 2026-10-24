/** Shared DOM helpers for the chat UI. */
import { setIcon } from "obsidian";

/**
 * Make a non-button element keyboard- and screen-reader-operable: role=button,
 * focusable (tabIndex 0), and Enter/Space fire the same handler as a click. Use
 * for the div/span controls that can't easily become a <button> without losing
 * their layout. The global `.mva-root :focus-visible` ring then applies for free.
 */
export function clickable(el: HTMLElement, handler: (e: Event) => void): void {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("click", handler);
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler(e);
    }
  });
}

/**
 * Give a real `<button>` nested inside a `clickable` element its own gesture
 * back. Stopping the CLICK is only half of it: `clickable` also answers
 * Enter/Space, and its `preventDefault()` cancels the button's own activation
 * click — so a button inside a clickable row does the ROW's job from the
 * keyboard while doing its own from the mouse. Stopping the key press before it
 * reaches the row is what makes the two agree.
 *
 * `stopPropagation`, never `preventDefault`: the default IS the button's click.
 * Only Enter and Space, so an ancestor's arrow-key navigation still works while
 * focus sits on the button.
 */
export function isolateActivation(el: HTMLElement): void {
  el.addEventListener("click", (e: Event) => e.stopPropagation());
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  });
}

/** Swap an icon control to `on` for a moment (a copy check), then back to `off`. */
export function flashIcon(btn: HTMLElement, on: string, off: string): void {
  btn.empty();
  setIcon(btn, on);
  window.setTimeout(() => {
    btn.empty();
    setIcon(btn, off);
  }, 1200);
}
