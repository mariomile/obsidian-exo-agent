/**
 * The auto-settle choice in the chats sidebar's header menu, beside the
 * grouping picker: it decides when an idle chat moves to the Settled shelf on
 * its own (core/thread-lifecycle). Its own file because `chat-list-view.ts` is
 * at its size ceiling (tests/size-contract.test.ts).
 */
import type { Menu } from "obsidian";
import { AUTO_SETTLE_DAY_CHOICES } from "../core/thread-lifecycle";

const label = (days: number): string =>
  days === 0 ? "Never auto-settle" : `Auto-settle after ${days} day${days === 1 ? "" : "s"}`;

export function addAutoSettleItems(menu: Menu, current: number, pick: (days: number) => void): void {
  menu.addSeparator();
  for (const days of AUTO_SETTLE_DAY_CHOICES) {
    menu.addItem((i) =>
      i
        .setTitle(label(days))
        .setIcon(days === 0 ? "circle-off" : "check-check")
        .setChecked(current === days)
        .onClick(() => pick(days)),
    );
  }
}
