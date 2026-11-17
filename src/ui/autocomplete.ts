import { setIcon } from "obsidian";
import { parseAcToken } from "../core/ac-token";
import { isComposingKey } from "../core/ime";

export interface AcItem {
  label: string;
  /** One-line description snippet, rendered muted + truncated after the label. */
  desc?: string;
  detail?: string;
  icon?: string;
  /** Text that replaces the trigger token (e.g. "/search " or a prompt body). */
  insert: string;
  onSelect?: () => void;
}

export interface AcProvider {
  trigger: string; // single char, e.g. "/" or "@"
  /** Keep matching past spaces so multi-word queries can refine the search. */
  allowSpaces?: boolean;
  getItems: (query: string) => AcItem[] | Promise<AcItem[]>;
}

/**
 * Lightweight inline autocomplete for a <textarea>. Detects a trigger token
 * (e.g. `/foo` or `@bar`) at the caret and shows a filterable popup anchored
 * above the input. Keyboard: ↑/↓ navigate, ⏎/Tab select, Esc dismiss.
 */
export class Autocomplete {
  private popup: HTMLElement;
  private items: AcItem[] = [];
  private sel = 0;
  private open = false;
  private tokenStart = -1;
  private tokenEnd = -1;
  private reqId = 0;
  private fetchTimer: number | null = null;
  // Suppression: after Esc or a completed pick, a space-allowing token would
  // keep re-matching as the user types the rest of the sentence (the inserted
  // "@path " itself still parses as a token). Remember where the dismissed
  // token started and how long its query was; stay closed while the user only
  // types FORWARD from there. Deleting back into the query re-engages.
  private suppressedStart = -1;
  private suppressedLen = 0;

  constructor(
    private ta: HTMLTextAreaElement,
    anchor: HTMLElement,
    private providers: AcProvider[]
  ) {
    this.popup = anchor.createDiv({ cls: "mva-ac" });
    this.popup.hide();
    ta.addEventListener("input", () => void this.onInput());
    ta.addEventListener("keydown", (e) => this.onKey(e), true);
    ta.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
  }

  private onInput(): void {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const tok = parseAcToken(before, this.providers);
    if (!tok) {
      this.suppressedStart = -1;
      this.close();
      return;
    }
    if (tok.start === this.suppressedStart) {
      if (tok.query.length >= this.suppressedLen) {
        this.close();
        return;
      }
      this.suppressedStart = -1; // deleted back into the token — re-engage
    }
    const prov = this.providers.find((p) => p.trigger === tok.trigger);
    if (!prov) {
      this.close();
      return;
    }
    const query = tok.query;
    this.tokenStart = tok.start;
    this.tokenEnd = pos; // token end at parse time — caret may move before selection
    // Debounce the fetch: getItems can scan the whole vault (e.g. the "@" provider),
    // so don't run it on every keystroke — only after a short typing pause.
    if (this.fetchTimer !== null) window.clearTimeout(this.fetchTimer);
    this.fetchTimer = window.setTimeout(() => {
      this.fetchTimer = null;
      void this.fetch(prov, query);
    }, 90);
  }

  private async fetch(prov: AcProvider, query: string): Promise<void> {
    const id = ++this.reqId;
    const items = await prov.getItems(query);
    if (id !== this.reqId) return; // a newer query superseded this one
    this.items = items.slice(0, 50);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.sel = 0;
    this.render();
  }

  private render(): void {
    this.popup.empty();
    this.items.forEach((it, i) => {
      const row = this.popup.createDiv({ cls: "mva-ac-item" + (i === this.sel ? " is-sel" : "") });
      if (it.icon) setIcon(row.createSpan({ cls: "mva-ac-icon" }), it.icon);
      row.createSpan({ cls: "mva-ac-label", text: it.label });
      if (it.desc) row.createSpan({ cls: "mva-ac-desc", text: it.desc });
      if (it.detail) row.createSpan({ cls: "mva-ac-detail", text: it.detail });
      row.onmousedown = (e) => {
        e.preventDefault();
        this.choose(i);
      };
    });
    this.popup.show();
    this.open = true;
    (this.popup.children[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.sel = (this.sel + 1) % this.items.length;
      this.render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.sel = (this.sel - 1 + this.items.length) % this.items.length;
      this.render();
    } else if ((e.key === "Enter" && !isComposingKey(e)) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.choose(this.sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.suppress(Math.max(0, this.tokenEnd - this.tokenStart - 1));
      this.close();
    }
  }

  private choose(i: number): void {
    const it = this.items[i];
    if (!it) return;
    const v = this.ta.value;
    // Replace [tokenStart, tokenEnd) — the token as parsed, not the live caret,
    // which may have moved via arrow keys while the popup was open.
    const end = Math.max(this.tokenStart, Math.min(this.tokenEnd, v.length));
    this.ta.value = v.slice(0, this.tokenStart) + it.insert + v.slice(end);
    const caret = this.tokenStart + it.insert.length;
    this.ta.setSelectionRange(caret, caret);
    // The inserted text (e.g. "@path ") still parses as a token for
    // space-allowing triggers — suppress so the popup doesn't pop right back.
    this.suppress(Math.max(0, it.insert.length - 1));
    this.close();
    it.onSelect?.();
    this.ta.dispatchEvent(new Event("input"));
    this.ta.focus();
  }

  private suppress(queryLen: number): void {
    this.suppressedStart = this.tokenStart;
    this.suppressedLen = queryLen;
  }

  private close(): void {
    this.open = false;
    this.reqId++;
    if (this.fetchTimer !== null) {
      window.clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    this.popup.hide();
  }
}
