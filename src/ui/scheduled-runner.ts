/**
 * Scheduled prompts, the impure half (core/scheduled-prompts.ts has the rules):
 * the store in plugin data, the 30s timer, and the dispatch into a chat.
 *
 * A run reuses the paths a message already has: an existing chat gets it
 * through `sendToConvo` (queued behind a running turn), "new" goes through
 * `startTaskConversation`, which opens the chat without taking the user's
 * active tab. The store is saved BEFORE the dispatch, so a crash mid-run can
 * never fire the same prompt twice.
 */
import { Notice } from "obsidian";
import type ExoPlugin from "../main";
import { chatView } from "./convo-bridge";
import { sendToConvo } from "./delegation";
import { formatWhen, isLate, scheduledMessage, takeDue, type ScheduledPrompt } from "../core/scheduled-prompts";

const TICK_MS = 30_000;
const RETRY_MS = 60_000;

const listeners = new Set<() => void>();

/** Called whenever the list changes; returns the unsubscribe. */
export function onScheduledChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = (): void => listeners.forEach((fn) => fn());

export function listScheduled(plugin: ExoPlugin): ScheduledPrompt[] {
  return [...(plugin.settings.scheduledPrompts ?? [])].sort((a, b) => a.dueAt - b.dueAt);
}

export async function addScheduled(
  plugin: ExoPlugin,
  input: Pick<ScheduledPrompt, "prompt" | "dueAt" | "target" | "repeat">,
): Promise<ScheduledPrompt> {
  const p: ScheduledPrompt = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    prompt: input.prompt,
    dueAt: input.dueAt,
    target: input.target,
    ...(input.repeat ? { repeat: input.repeat } : {}),
    createdAt: Date.now(),
  };
  plugin.settings.scheduledPrompts = [...(plugin.settings.scheduledPrompts ?? []), p];
  await plugin.saveSettings();
  changed();
  return p;
}

export async function cancelScheduled(plugin: ExoPlugin, id: string): Promise<boolean> {
  const list = plugin.settings.scheduledPrompts ?? [];
  // A retry (`<id>-retry`) goes with the prompt it retries.
  const keep = list.filter((p) => p.id !== id && p.id !== `${id}-retry`);
  if (keep.length === list.length) return false;
  plugin.settings.scheduledPrompts = keep;
  await plugin.saveSettings();
  changed();
  return true;
}

/** The title of the chat a prompt targets, for lists. */
export function targetTitle(plugin: ExoPlugin, target: string): string {
  if (target === "new") return "a new chat";
  return chatView(plugin.app)?.allConvos().find((c) => c.id === target)?.title ?? "a chat that was deleted";
}

/** Start the timer. Runs once as soon as the workspace is ready, which is
 *  what fires a prompt that came due while Obsidian was closed. */
export function startScheduledPrompts(plugin: ExoPlugin): void {
  const tick = () => void runDue(plugin);
  plugin.registerInterval(window.setInterval(tick, TICK_MS));
  plugin.app.workspace.onLayoutReady(tick);
}

let running = false;

async function runDue(plugin: ExoPlugin): Promise<void> {
  const now = Date.now();
  if (running || !(plugin.settings.scheduledPrompts ?? []).some((p) => p.dueAt <= now)) return;
  // No chat view open: create one in the background, without revealing it.
  // It may come back deferred, in which case the next tick finds it.
  if (!chatView(plugin.app)) await plugin.ensureChatView();
  const view = chatView(plugin.app);
  if (!view) return;
  running = true;
  try {
    const { due, rest } = takeDue(plugin.settings.scheduledPrompts, now);
    plugin.settings.scheduledPrompts = rest;
    await plugin.saveSettings();
    const retry: ScheduledPrompt[] = [];
    const retarget = new Map<string, string>();
    for (const p of due) {
      const text = scheduledMessage(p, now);
      // An archived or deleted chat is one the user would never see it in.
      const target = p.target === "new" ? undefined : view.allConvos().find((c) => c.id === p.target && !c.archived);
      const asRetry = { ...p, id: `${p.id.replace(/-retry$/, "")}-retry`, dueAt: now + RETRY_MS, repeat: undefined };
      try {
        const outcome = target ? sendToConvo(view, target.id, text, "queue") : null;
        // A chat stopped a moment ago drops a queued message: try again shortly.
        if (outcome === "stopping") {
          retry.push(asRetry);
          continue;
        }
        if (!outcome) {
          const id = view.startTaskConversation(text);
          // "This chat" is gone: a repeating prompt follows to the new chat
          // rather than opening another one on every run.
          if (p.target !== "new" && p.repeat && id) retarget.set(p.id, id);
        }
      } catch (e) {
        console.warn("[exo] scheduled prompt failed to start", e);
        retry.push(asRetry);
        continue;
      }
      if (isLate(p.dueAt, now)) {
        new Notice(`Exo: a scheduled task due ${formatWhen(p.dueAt)} ran late: Obsidian was closed or asleep.`, 10_000);
      }
    }
    if (retry.length || retarget.size) {
      plugin.settings.scheduledPrompts = [
        ...plugin.settings.scheduledPrompts.map((p) => (retarget.has(p.id) ? { ...p, target: retarget.get(p.id) as string } : p)),
        ...retry,
      ];
      await plugin.saveSettings();
    }
    changed();
  } finally {
    running = false;
  }
}
