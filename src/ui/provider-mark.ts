import { setIcon } from "obsidian";
import type { ProviderId } from "../providers/types";
import { ADAPTERS } from "../providers/registry";

/** Draw a provider's own mark into `el`: the Claude spark in its orange, the
 *  OpenAI mark in the text color. One helper so the header, the model chip and
 *  the picker rows always agree. */
export function setProviderMark(el: HTMLElement, provider: ProviderId): void {
  const a = ADAPTERS[provider];
  setIcon(el, a.icon);
  el.style.color = a.iconTinted ? a.brandColor : "";
}
