import { Component } from "obsidian";

interface PreviewLifetime {
  owner: Component;
  child: Component;
  node: HTMLElement;
}

interface TranscriptRegistry {
  observer: MutationObserver;
  entries: Set<PreviewLifetime>;
}

const transcripts = new WeakMap<HTMLElement, TranscriptRegistry>();
const deletedTranscripts = new WeakSet<HTMLElement>();

/** Capture before an asynchronous render so tab detachment and deletion stay distinct. */
export function previewTargetAlive(node: HTMLElement): () => boolean {
  const list = node.closest<HTMLElement>(".mva-list");
  if (list) return () => !deletedTranscripts.has(list) && list.contains(node);
  const parent = node.parentElement;
  if (parent) return () => parent.contains(node);
  const wasConnected = node.isConnected;
  return () => !wasConnected || node.isConnected;
}

/** A detached, reusable transcript stays alive; removing one of its nodes does not. */
export function ownedPreviewComponent(owner: Component, node: HTMLElement): Component {
  const child = owner.addChild(new Component());
  const list = node.closest<HTMLElement>(".mva-list");
  const Observer = node.ownerDocument.defaultView?.MutationObserver;
  if (!list || !Observer) return child;

  let registry = transcripts.get(list);
  if (!registry) {
    const entries = new Set<PreviewLifetime>();
    const observer = new Observer(() => {
      for (const entry of [...entries]) {
        if (!list.contains(entry.node)) entry.owner.removeChild(entry.child);
      }
    });
    registry = { observer, entries };
    transcripts.set(list, registry);
    observer.observe(list, { childList: true, subtree: true });
  }

  const entry = { owner, child, node };
  const captured = registry;
  captured.entries.add(entry);
  child.register(() => {
    captured.entries.delete(entry);
    if (captured.entries.size) return;
    captured.observer.disconnect();
    transcripts.delete(list);
  });
  return child;
}

/** Call when deleting a conversation, rather than merely detaching its reusable list. */
export function disposeTranscriptPreviews(list: HTMLElement): void {
  deletedTranscripts.add(list);
  const registry = transcripts.get(list);
  if (!registry) return;
  for (const entry of [...registry.entries]) entry.owner.removeChild(entry.child);
}
