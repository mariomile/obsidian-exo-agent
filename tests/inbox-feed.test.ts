import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { InboxFeed } from "../src/obsidian/inbox-feed";
import type ExoPlugin from "../src/main";
import type { AutomationRunRecord } from "../src/core/automations";

const NOW = Date.UTC(2026, 9, 24, 12);

function run(id: string): AutomationRunRecord {
  return { id, slug: id, name: `Run ${id}`, startedAt: NOW, ok: true, reportPath: "", writes: [`${id}.md`], checkpoint: [] };
}

function note(path: string, mtime: number, body: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop()!.replace(/\.md$/, "");
  f.extension = "md";
  f.stat = { mtime };
  bodies.set(path, body);
  return f;
}

const bodies = new Map<string, string>();

function fakePlugin(over: { loadAutomationRuns?: () => Promise<AutomationRunRecord[]>; queue?: TFolder | null } = {}) {
  return {
    settings: {
      proposalKernelEnabled: false,
      exoQueueFolder: "Queue",
      dailyPulseReviewState: {},
      inboxSeen: {},
    },
    loadAutomationRuns: over.loadAutomationRuns ?? (async () => []),
    listChatRows: () => [],
    automationStore: { list: () => [] },
    register: () => {},
    app: {
      workspace: { onLayoutReady: () => {} },
      vault: {
        getAbstractFileByPath: () => over.queue ?? null,
        cachedRead: async (f: TFile) => bodies.get(f.path) ?? "",
      },
    },
  } as unknown as ExoPlugin;
}

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  bodies.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InboxFeed.refresh", () => {
  it("drops a load that lands after a newer one started", async () => {
    const pending: ((runs: AutomationRunRecord[]) => void)[] = [];
    const feed = new InboxFeed(
      fakePlugin({ loadAutomationRuns: () => new Promise<AutomationRunRecord[]>((r) => pending.push(r)) })
    );
    const older = feed.refresh();
    const newer = feed.refresh();
    pending[1]([]); // the newer load: the group was reviewed
    await newer;
    pending[0]([run("stale")]); // the older load still saw it unreviewed
    await older;
    expect(feed.current(NOW).count).toBe(0);
  });
});

describe("InboxFeed polling", () => {
  it("ticks only while a surface is subscribed", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => [] as AutomationRunRecord[]);
    const feed = new InboxFeed(fakePlugin({ loadAutomationRuns: load }));

    await vi.advanceTimersByTimeAsync(180_000);
    expect(load).not.toHaveBeenCalled();

    const off = feed.onChange(() => {});
    expect(load).toHaveBeenCalledTimes(1); // the first subscriber loads at once
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);

    off();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("InboxFeed queue answers", () => {
  it("scans the most recently modified notes, not the listing order", async () => {
    const queue = new TFolder();
    const at = new Date(NOW - 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    // 25 old unanswered notes listed first, one fresh answer listed last.
    queue.children = [
      ...Array.from({ length: 25 }, (_, i) => note(`Queue/old-${i}.md`, NOW - 86_400_000 + i, "pending")),
      note("Queue/fresh.md", NOW - 1_000, `---\nexo-answered: ${local}\n---\nbody`),
    ];
    const feed = new InboxFeed(fakePlugin({ queue }));
    await feed.refresh();
    expect(feed.current(NOW).items.map((i) => i.title)).toContain("fresh");
  });
});

describe("InboxFeed.start on a hot reload", () => {
  it("onload starts the feed only once the automation store exists", async () => {
    // A hot reload runs onLayoutReady at once, so start() touches the store
    // synchronously: started before it, onload threw and the plugin failed.
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const store = main.indexOf("this.automationStore = new AutomationStore(");
    const start = main.indexOf("this.inbox.start();");
    expect(store, "automation store construction moved").toBeGreaterThan(-1);
    expect(start, "inbox.start() runs before the automation store exists").toBeGreaterThan(store);
  });

  it("subscribes to the automation list when the layout is already ready", () => {
    const listeners: (() => void)[] = [];
    const plugin = fakePlugin();
    Object.assign(plugin.app.workspace, { onLayoutReady: (cb: () => void) => cb() });
    Object.assign(plugin.automationStore, { onChange: (cb: () => void) => listeners.push(cb) });
    new InboxFeed(plugin).start();
    expect(listeners).toHaveLength(1);
  });
});
