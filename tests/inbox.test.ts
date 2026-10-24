import { describe, it, expect } from "vitest";
import {
  buildInbox,
  groupUnreviewedRuns,
  inboxSig,
  isUnseen,
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
  proposals: 0,
  pulse: initialDailyPulseReviewState(),
  answers: [],
  seen: {},
  now: NOW,
  ...over,
});

describe("isUnseen", () => {
  it("is true when a turn landed after the last visit", () => {
    expect(isUnseen(chat("a"))).toBe(true);
  });
  it("is false for the chat in front of you", () => {
    expect(isUnseen(chat("a", { focused: true }))).toBe(false);
  });
  it("is cleared by a read mark as well as by a visit", () => {
    expect(isUnseen(chat("a", { seenAt: NOW - HOUR / 2 }))).toBe(false);
    expect(isUnseen(chat("a", { lastActiveAt: NOW }))).toBe(false);
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
    expect(openFailedRuns(runs)).toEqual([]);
    expect(buildInbox(input({ runs })).count).toBe(0);
  });

  it("drops a dismissed failed run", () => {
    expect(openFailedRuns([run("f", { ok: false, writes: [], reviewedAt: NOW })])).toEqual([]);
  });

  it("names the group after the automation, without an agent run's trigger", () => {
    const [g] = groupUnreviewedRuns([run("a", { name: "Inbox Triager (create _inbox x.md)", slug: "triager" })]);
    expect(g).toMatchObject({ key: "triager", name: "Inbox Triager", writes: 1 });
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
