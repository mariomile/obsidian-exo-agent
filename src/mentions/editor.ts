/**
 * In-document Connections surface (CM6). An inline underline on every OUTGOING
 * unlinked mention (a title this note cites in plain text) — click →
 * {@link openMentionPopover}. Gated live behind a setting so the extension is
 * inert when off (no reload needed).
 *
 * The mention set is recomputed async (debounced) off the live editor buffer and
 * pushed into a StateField; between recomputes, offsets are remapped through
 * edits so underlines never drift. DOM/CM6 shell — the matching, flattening and
 * mutation logic it renders is pure and unit-tested in `mentions-core`.
 *
 * NOTE: a bottom-of-note "Connections block" once lived here as a CM6 block
 * widget. Block decorations at doc end fight Obsidian's editor — CM6 rejects them
 * from view plugins AND from the decorations facet with `Block decorations may
 * not be specified via plugins`, breaking every note open. Removed 2026-07-20.
 * If reintroduced, render it as a MarkdownRenderChild footer, not a CM6 widget.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { MarkdownView, TFile } from "obsidian";
import type ExoPlugin from "../main";
import { gatherOutgoing, defaultExcludePrefixes, OutgoingIndexCache } from "./connections";
import { loadIgnoreStore } from "./ignore-store";
import { openMentionPopover } from "./popover";
import type { FlatOutgoing } from "./mentions-core";

interface OutgoingState {
  path: string;
  flats: FlatOutgoing[];
}

const setOutgoing = StateEffect.define<OutgoingState>();
/** Dispatched after an action that changes the mention set without editing the
 *  doc (e.g. Ignore) — asks the view plugin to recompute. */
const forceRecompute = StateEffect.define<null>();

const outgoingField = StateField.define<OutgoingState>({
  create: () => ({ path: "", flats: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOutgoing)) return e.value;
    if (tr.docChanged) {
      const flats = value.flats
        .map((f) => ({
          ...f,
          range: { start: tr.changes.mapPos(f.range.start), end: tr.changes.mapPos(f.range.end) },
        }))
        .filter((f) => f.range.end > f.range.start);
      return { path: value.path, flats };
    }
    return value;
  },
});

function fileForView(plugin: ExoPlugin, view: EditorView): TFile | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const v = leaf.view;
    if (v instanceof MarkdownView && (v.editor as unknown as { cm?: EditorView })?.cm === view) {
      return v.file;
    }
  }
  return null;
}

export function mentionsExtension(plugin: ExoPlugin) {
  // One target index shared by every editor; its invalidation events unload with the plugin.
  const index = new OutgoingIndexCache(plugin.app, plugin);
  const plug = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private timer: number | null = null;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
        this.schedule(view);
      }

      update(u: ViewUpdate): void {
        const gotData = u.transactions.some((t) => t.effects.some((e) => e.is(setOutgoing)));
        const gotForce = u.transactions.some((t) => t.effects.some((e) => e.is(forceRecompute)));
        if (gotData || u.docChanged) this.decorations = this.build(u.view);
        if (u.docChanged || gotForce) this.schedule(u.view);
      }

      private enabled(): boolean {
        return !!plugin.settings.connectionsInlineUnderline;
      }

      private build(view: EditorView): DecorationSet {
        const s = plugin.settings;
        const data = view.state.field(outgoingField, false) ?? { path: "", flats: [] };
        const builder = new RangeSetBuilder<Decoration>();
        if (s.connectionsInlineUnderline) {
          const sorted = [...data.flats].sort((a, b) => a.range.start - b.range.start);
          for (const f of sorted) {
            builder.add(
              f.range.start,
              f.range.end,
              Decoration.mark({
                class: "exo-mention-underline",
                attributes: { "data-target": f.targetBasename },
              }),
            );
          }
        }
        return builder.finish();
      }

      private schedule(view: EditorView): void {
        if (!this.enabled()) {
          if (this.decorations.size) this.decorations = Decoration.none;
          return;
        }
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.run(view), 600);
      }

      private async run(view: EditorView): Promise<void> {
        const file = fileForView(plugin, view);
        if (!file) return;
        const ignore = await loadIgnoreStore(plugin.app, plugin.paths.mentions);
        const flats = await gatherOutgoing(plugin.app, file, index, ignore, {
          stem: !!plugin.settings.connectionsStemming,
          text: view.state.doc.toString(),
          excludePrefixes: defaultExcludePrefixes(plugin.paths.root),
        });
        view.dispatch({ effects: setOutgoing.of({ path: file.path, flats }) });
      }

      destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent, view: EditorView) {
          if (!plugin.settings.connectionsInlineUnderline) return false;
          const el = (e.target as HTMLElement | null)?.closest?.(".exo-mention-underline") as HTMLElement | null;
          if (!el) return false;
          const targetBasename = el.getAttribute("data-target");
          if (!targetBasename) return false;
          const data = view.state.field(outgoingField, false);
          const file = fileForView(plugin, view);
          if (!data || !file) return false;
          const ranges = data.flats.filter((f) => f.targetBasename === targetBasename).map((f) => f.range);
          const pos = view.posAtDOM(el);
          const range = ranges.find((r) => r.start <= pos + 1 && r.end >= pos) ?? ranges[0];
          if (!range) return false;
          openMentionPopover({
            app: plugin.app,
            view,
            sourcePath: file.path,
            targetBasename,
            range,
            allRanges: ranges,
            anchor: { x: e.clientX, y: e.clientY + 12 },
            onChange: () => view.dispatch({ effects: forceRecompute.of(null) }),
            mentionsDir: plugin.paths.mentions,
          });
          return false;
        },
      },
    },
  );
  return [outgoingField, plug];
}
