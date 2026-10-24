import { describe, it, expect } from "vitest";
import {
  buildInbox,
  groupUnreviewedRuns,
  inboxSig,
  isUnseen,
  LEGACY_RUNS_KEY,
  openFailedRuns,
  pruneSeen,
  type InboxChat,
  type InboxInput,
} from "../src/core/inbox";
import { initialDailyPulseReviewState } from "../src/core/daily-pulse";
import type { AutomationRunRecord } from "../src/core/automations";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const chat = (id: string, over: Partial<InboxChat> = {}): InboxChat => ({
  id,
  title: id,
  focused: false,
  streaming: false,
  stopped: false,
  pendingPerm: false,
  pendingAsk: false,
  poisoned: false,
  archived: false,
  hasMessages: true,
  updatedAt: NOW - HOUR,
  lastActiveAt: NOW - 2 * HOUR,
  ...over,
});

const run = (id: string, over: Partial<AutomationRunRecord> = {}): AutomationRunRecord => ({
  id,
  name: "Digest",
  slug: "digest",
  startedAt: NOW - HOUR,
  ok: true,
  reportPath: "",
  writes: ["a.md"],
  checkpoint: [],
  ...over,
});

const input = (over: Partial<InboxInput> = {}): InboxInput => ({
  chats: [],
  runs: [],
  automations: [{ slug: "digest", name: "Digest" }],
  proposals: 0,
  pulse: initialDailyPulseReviewState(),
  answers: [],
  seen: {},
  now: NOW,
  ...over,
});

describe("isUnseen", () => {
  it("is true when a turn landed after the last visit", () => {
    expect(isUnseen(chat("a"), NOW)).toBe(true);
  });
  it("is false for the chat in front of you", () => {
    expect(isUnseen(chat("a", { focused: true }), NOW)).toBe(false);
  });
  it("is cleared by a read mark as well as by a visit", () => {
    expect(isUnseen(chat("a", { seenAt: NOW - HOUR / 2 }), NOW)).toBe(false);
    expect(isUnseen(chat("a", { lastActiveAt: NOW }), NOW)).toBe(false);
  });
  it("holds while a chat is snoozed and turns true when it wakes", () => {
    const snoozed = chat("a", { updatedAt: NOW - 3 * HOUR, lastActiveAt: NOW - 4 * HOUR, snoozedAt: NOW - 2 * HOUR });
    expect(isUnseen({ ...snoozed, snoozedUntil: NOW + HOUR }, NOW)).toBe(false);
    expect(isUnseen({ ...snoozed, snoozedUntil: NOW - HOUR }, NOW)).toBe(true);
    expect(isUnseen({ ...snoozed, snoozedUntil: NOW - HOUR, seenAt: NOW - HOUR / 2 }, NOW)).toBe(false);
  });
});

describe("buildInbox: chats", () => {
  it("counts a blocked and unseen chat once, as a request", () => {
    const inbox = buildInbox(input({ chats: [chat("a", { pendingPerm: true, streaming: true, permRule: "Bash(git)" })] }));
    expect(inbox.count).toBe(1);
    expect(inbox.items[0]).toMatchObject({ id: "chat:a:perm", kind: "request", permRule: "Bash(git)" });
  });

  it("files an open question as an ask request", () => {
    const inbox = buildInbox(input({ chats: [chat("a", { pendingAsk: true, streaming: true })] }));
    expect(inbox.items.map((i) => i.id)).toEqual(["chat:a:ask"]);
  });

  it("leaves archived chats and empty husks out, as the sidebar does", () => {
    const inbox = buildInbox(input({
      chats: [chat("arch", { archived: true }), chat("arch-err", { archived: true, poisoned: true }), chat("husk", { hasMessages: false })],
    }));
    expect(inbox.count).toBe(0);
  });

  it("leaves a still-snoozed chat out until it wakes", () => {
    const c = chat("a", { snoozedAt: NOW - HOUR / 2, snoozedUntil: NOW + HOUR });
    expect(buildInbox(input({ chats: [c] })).count).toBe(0);
  });

  it("leaves streaming and stopped chats out", () => {
    const inbox = buildInbox(input({ chats: [chat("s", { streaming: true }), chat("x", { stopped: true })] }));
    expect(inbox.count).toBe(0);
  });

  it("prefers the error over the new reply on an unseen poisoned chat", () => {
    const inbox = buildInbox(input({ chats: [chat("a", { poisoned: true })] }));
    expect(inbox.items.map((i) => i.id)).toEqual(["chat:a:error"]);
    expect(inbox.items[0].verbs).toEqual(["resolve", "archive"]);
  });

  it("drops a dismissed error and a read reply", () => {
    const inbox = buildInbox(input({ chats: [chat("e", { poisoned: true, seenAt: NOW }), chat("r", { seenAt: NOW })] }));
    expect(inbox.count).toBe(0);
  });

  it("labels a chat that woke from a snooze with no new turn as Snooze ended, dated at the wake", () => {
    const woke = chat("a", { updatedAt: NOW - 3 * HOUR, lastActiveAt: NOW - 4 * HOUR, snoozedAt: NOW - 2 * HOUR, snoozedUntil: NOW - HOUR });
    const [it] = buildInbox(input({ chats: [woke] })).items;
    expect(it).toMatchObject({ kind: "result", detail: "Snooze ended", at: NOW - HOUR, verbs: ["read"] });
  });

  it("keeps New reply, dated at the turn, when a reply landed while the chat was snoozed", () => {
    const c = chat("a", { updatedAt: NOW - 90 * 60_000, lastActiveAt: NOW - 4 * HOUR, snoozedAt: NOW - 2 * HOUR, snoozedUntil: NOW - HOUR / 2 });
    const [it] = buildInbox(input({ chats: [c] })).items;
    expect(it).toMatchObject({ detail: "New reply", at: NOW - 90 * 60_000 });
  });

  it("lists an unseen finished chat as a new result", () => {
    const inbox = buildInbox(input({ chats: [chat("a")] }));
    expect(inbox.items[0]).toMatchObject({ id: "chat:a:reply", kind: "result", verbs: ["read"] });
  });

  it("contributes nothing when no chat view is open", () => {
    expect(buildInbox(input({ chats: null })).count).toBe(0);
  });
});

describe("buildInbox: runs", () => {
  it("groups three write runs of one automation into one item with three run ids", () => {
    const runs = [run("r1", { startedAt: NOW - 3 * HOUR }), run("r2", { startedAt: NOW - 2 * HOUR }), run("r3")];
    const inbox = buildInbox(input({ runs }));
    expect(inbox.count).toBe(1);
    expect(inbox.items[0]).toMatchObject({ id: "runs:digest", kind: "request", target: "digest" });
    expect(inbox.items[0].runIds).toEqual(["r3", "r2", "r1"]);
  });

  it("keeps a failed write run in its group only, never as an error too", () => {
    const inbox = buildInbox(input({ runs: [run("f", { ok: false })] }));
    expect(inbox.items.map((i) => i.id)).toEqual(["runs:digest"]);
  });

  it("lists a failed run with no writes as an error", () => {
    const inbox = buildInbox(input({ runs: [run("f", { ok: false, writes: [] })] }));
    expect(inbox.items[0]).toMatchObject({ id: "run:f", kind: "error", runIds: ["f"] });
  });

  it("closes a failed run once a later run of the same automation succeeded", () => {
    const runs = [run("f", { ok: false, writes: [], startedAt: NOW - 2 * HOUR }), run("ok", { writes: [], startedAt: NOW - HOUR })];
    expect(openFailedRuns(runs, [])).toEqual([]);
    expect(buildInbox(input({ runs })).count).toBe(0);
  });

  it("keeps an orphan failed run open when an unrelated orphan run succeeded later", () => {
    const orphan = (id: string, name: string, over: Partial<AutomationRunRecord> = {}) =>
      run(id, { name, slug: undefined, writes: [], ...over });
    const runs = [
      orphan("f", "Weekly Digest", { ok: false, startedAt: NOW - 2 * HOUR }),
      orphan("other", "Something Else", { startedAt: NOW - HOUR }),
    ];
    expect(openFailedRuns(runs, []).map((r) => r.id)).toEqual(["f"]);
    expect(buildInbox(input({ runs })).items.map((i) => i.id)).toEqual(["run:f"]);
  });

  it("closes an orphan failed run on a later success of the same name, trigger suffix aside", () => {
    const orphan = (id: string, name: string, over: Partial<AutomationRunRecord> = {}) =>
      run(id, { name, slug: undefined, writes: [], ...over });
    const runs = [
      orphan("f", "Old Agent (create a.md)", { ok: false, startedAt: NOW - 2 * HOUR }),
      orphan("ok", "Old Agent (create b.md)", { startedAt: NOW - HOUR }),
    ];
    expect(openFailedRuns(runs, [])).toEqual([]);
  });

  it("drops a dismissed failed run", () => {
    expect(openFailedRuns([run("f", { ok: false, writes: [], reviewedAt: NOW })], [])).toEqual([]);
  });

  it("names the group after the automation, without an agent run's trigger", () => {
    const autos = [{ slug: "triager", name: "Inbox Triager" }];
    const [g] = groupUnreviewedRuns([run("a", { name: "Inbox Triager (create _inbox x.md)", slug: "triager" })], autos);
    expect(g).toMatchObject({ key: "triager", name: "Inbox Triager", writes: 1 });
  });
});

describe("buildInbox: slug-less runs", () => {
  const autos = [{ slug: "triager", name: "Inbox Triager" }];
  const legacy = (id: string, name: string, over: Partial<AutomationRunRecord> = {}) =>
    run(id, { name, slug: undefined, ...over });

  it("files pre-v2 runs under the automation that claims their name, as the Automations tab does", () => {
    const runs = [
      legacy("a", "Inbox Triager (create _inbox a.md)"),
      legacy("b", "Inbox Triager (create _inbox b.md)", { startedAt: NOW - 2 * HOUR }),
      legacy("c", "Inbox Triager"),
    ];
    const groups = groupUnreviewedRuns(runs, autos);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "triager", name: "Inbox Triager" });
    expect(buildInbox(input({ runs, automations: autos })).count).toBe(1);
  });

  it("puts unclaimed pre-v2 runs in one Older runs group", () => {
    const runs = [legacy("x", "Old one (create a.md)"), legacy("y", "Another old one")];
    const groups = groupUnreviewedRuns(runs, autos);
    expect(groups.map((g) => [g.key, g.name])).toEqual([[LEGACY_RUNS_KEY, "Older runs"]]);
  });

  it("targets a failed pre-v2 run at its automation's slug, so Run again resolves it", () => {
    const inbox = buildInbox(input({ runs: [legacy("f", "Inbox Triager (create x.md)", { ok: false, writes: [] })], automations: autos }));
    expect(inbox.items[0]).toMatchObject({ id: "run:f", title: "Inbox Triager", target: "triager" });
  });

  it("files a deleted automation's runs under Older runs, as the Automations tab does", () => {
    const runs = [run("w", { slug: "gone", name: "Gone", startedAt: NOW - 2 * HOUR }), run("f", { slug: "gone", name: "Gone", ok: false, writes: [] })];
    const inbox = buildInbox(input({ runs, automations: autos }));
    expect(inbox.items.map((i) => [i.id, i.title, i.target])).toEqual([
      ["runs:" + LEGACY_RUNS_KEY, "Older runs", LEGACY_RUNS_KEY],
      ["run:f", "Gone", LEGACY_RUNS_KEY],
    ]);
  });

  it("closes a failed pre-v2 run once its automation later succeeded under a slug", () => {
    const runs = [
      legacy("f", "Inbox Triager", { ok: false, writes: [], startedAt: NOW - 2 * HOUR }),
      run("ok", { slug: "triager", name: "Inbox Triager", writes: [], startedAt: NOW - HOUR }),
    ];
    expect(openFailedRuns(runs, autos)).toEqual([]);
  });
});

describe("buildInbox: proposals, pulse, answers", () => {
  it("counts pending suggestions once", () => {
    const inbox = buildInbox(input({ proposals: 5 }));
    expect(inbox.count).toBe(1);
    expect(inbox.items[0]).toMatchObject({ id: "proposals", kind: "request", title: "5 suggestions" });
  });

  it("counts a Daily Pulse with 12 items once", () => {
    const pulse = { ...initialDailyPulseReviewState(), status: "ready" as const, itemCount: 12, lastSuccessAt: NOW - HOUR };
    const inbox = buildInbox(input({ pulse }));
    expect(inbox.count).toBe(1);
    expect(inbox.items[0].id).toBe(`pulse:${NOW - HOUR}`);
  });

  it("shows a pulse error instead of the ready pulse, until dismissed", () => {
    const pulse = {
      ...initialDailyPulseReviewState(),
      status: "error" as const,
      itemCount: 3,
      lastSuccessAt: NOW - DAY,
      lastAttemptAt: NOW - HOUR,
      lastError: "boom",
    };
    expect(buildInbox(input({ pulse })).items.map((i) => i.id)).toEqual([`pulse-error:${NOW - HOUR}`]);
    expect(buildInbox(input({ pulse: { ...pulse, lastReviewedAt: NOW } })).count).toBe(0);
  });

  it("versions ids, so a new pulse or answer is not hidden by an old read", () => {
    const pulse = (t: number) => ({ ...initialDailyPulseReviewState(), itemCount: 1, lastSuccessAt: t });
    expect(buildInbox(input({ pulse: pulse(1) })).items[0].id).not.toBe(buildInbox(input({ pulse: pulse(2) })).items[0].id);
    const answer = (t: number) => ({ path: "Q/a.md", name: "a", answeredAt: t });
    const seen = { [`answer:Q/a.md@${NOW - 2 * HOUR}`]: NOW - HOUR };
    expect(buildInbox(input({ answers: [answer(NOW - 2 * HOUR)], seen })).count).toBe(0);
    expect(buildInbox(input({ answers: [answer(NOW - HOUR)], seen })).items[0].id).toBe(`answer:Q/a.md@${NOW - HOUR}`);
  });

  it("keeps queue answers for 24h only", () => {
    const answers = [{ path: "Q/old.md", name: "old", answeredAt: NOW - DAY }, { path: "Q/new.md", name: "new", answeredAt: NOW - HOUR }];
    expect(buildInbox(input({ answers })).items.map((i) => i.title)).toEqual(["new"]);
  });
});

describe("buildInbox: shape", () => {
  it("orders requests, errors, results and keeps count === items.length with no cap", () => {
    const chats = Array.from({ length: 12 }, (_, n) => chat(`c${n}`));
    const inbox = buildInbox(
      input({
        chats: [...chats, chat("p", { pendingPerm: true, streaming: true }), chat("e", { poisoned: true })],
        proposals: 1,
      }),
    );
    expect(inbox.count).toBe(inbox.items.length);
    expect(inbox.count).toBe(15);
    expect(inbox.byKind).toEqual({ request: 2, error: 1, result: 12 });
    const kinds = inbox.items.map((i) => i.kind);
    expect(kinds.indexOf("error")).toBeGreaterThan(kinds.lastIndexOf("request"));
    expect(kinds.indexOf("result")).toBeGreaterThan(kinds.lastIndexOf("error"));
  });

  it("changes the signature when a row would render differently", () => {
    const a = buildInbox(input({ chats: [chat("a")] })).items;
    const b = buildInbox(input({ chats: [chat("a", { title: "renamed" })] })).items;
    expect(inboxSig(a)).not.toBe(inboxSig(b));
    expect(inboxSig(a)).toBe(inboxSig(buildInbox(input({ chats: [chat("a")] })).items));
  });
});

describe("pruneSeen", () => {
  it("drops marks older than a week and keeps the rest", () => {
    const seen = { old: NOW - 8 * DAY, fresh: NOW - DAY };
    expect(pruneSeen(seen, NOW)).toEqual({ fresh: NOW - DAY });
  });
});
