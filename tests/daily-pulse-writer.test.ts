import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import type { DailyPulse } from "../src/core/daily-pulse";
import {
  DAILY_PULSE_END_MARKER,
  DAILY_PULSE_START_MARKER,
  DailyPulseWriteError,
  renderDailyPulseBlock,
  writeDailyPulse,
  type DailyPulseFileAdapter,
} from "../src/obsidian/daily-pulse";

const NOW = Date.parse("2026-07-20T08:00:00.000Z");

function pulse(): DailyPulse {
  return {
    generatedAt: NOW,
    sections: [
      {
        title: "Attention",
        items: [{
          id: "automation:run-1",
          kind: "automation",
          title: "Morning sync",
          detail: "1 write to review",
          target: { kind: "automation", id: "run-1" },
          action: { kind: "review", target: "automation", id: "run-1" },
        }],
      },
      {
        title: "Open loops",
        items: [{
          id: "loop:loop-1",
          kind: "loop",
          title: "Follow up",
          target: { kind: "loop", id: "loop-1" },
          action: { kind: "review", target: "loop", id: "loop-1" },
        }],
      },
      {
        title: "Suggestions",
        items: [{
          id: "proposal:proposal-1",
          kind: "proposal",
          title: "Capture decision",
          target: { kind: "proposal", id: "proposal-1" },
          action: { kind: "review", target: "proposal", id: "proposal-1" },
        }],
      },
      {
        title: "Recent work",
        items: [{
          id: "note:Active/Projects/Exo.md",
          kind: "note",
          title: "Exo",
          target: { kind: "note", path: "Active/Projects/Exo.md" },
          action: { kind: "open", path: "Active/Projects/Exo.md" },
        }],
      },
    ],
  };
}

function adapter(initial: string | null): DailyPulseFileAdapter & {
  content: () => string | null;
  writes: ReturnType<typeof vi.fn>;
} {
  let content = initial;
  const writes = vi.fn(async (_path: string, next: string) => {
    content = next;
  });
  return {
    read: async () => content,
    write: writes,
    content: () => content,
    writes,
  };
}

describe("Daily Pulse non-destructive writer", () => {
  it("creates a missing review file with coherent AI-managed frontmatter and markers", async () => {
    const file = adapter(null);

    const result = await writeDailyPulse(file, new WriteQueue(), pulse(), []);

    expect(result).toEqual({ path: "_system/review.md", created: true, changed: true });
    expect(file.content()).toMatch(/^---\ntype: reference\ntags:\n[ ]{2}- type\/reference\ncreated_by: exo\nlast_updated: 2026-07-20\nlast_edited_by: exo\n---\n\n/);
    expect(file.content()).toContain(`${DAILY_PULSE_START_MARKER}\n`);
    expect(file.content()).toContain(`\n${DAILY_PULSE_END_MARKER}\n`);
  });

  it("appends one block with only the minimal separator when markers are absent", async () => {
    const existing = "---\ntype: reference\n---\n\n# Manual review\nManual bytes.";
    const file = adapter(existing);

    await writeDailyPulse(file, new WriteQueue(), pulse(), []);

    expect(file.content()?.startsWith(`${existing}\n\n${DAILY_PULSE_START_MARKER}`)).toBe(true);
    expect(file.content()?.slice(0, existing.length)).toBe(existing);
  });

  it("replaces only the bytes between a valid marker pair", async () => {
    const prefix = "---\r\ntype: reference\r\n---\r\n\r\n# Manual\r\n";
    const suffix = "\r\n\r\nManual tail without normalization.\r\n";
    const existing = `${prefix}${DAILY_PULSE_START_MARKER}\r\nOLD\r\n${DAILY_PULSE_END_MARKER}${suffix}`;
    const file = adapter(existing);

    await writeDailyPulse(file, new WriteQueue(), pulse(), []);

    expect(file.content()?.slice(0, prefix.length + DAILY_PULSE_START_MARKER.length))
      .toBe(`${prefix}${DAILY_PULSE_START_MARKER}`);
    expect(file.content()?.endsWith(`${DAILY_PULSE_END_MARKER}${suffix}`)).toBe(true);
    expect(file.content()).not.toContain("OLD");
  });

  it.each([
    ["start only", `${DAILY_PULSE_START_MARKER}\nold`, "partial-markers"],
    ["end only", `old\n${DAILY_PULSE_END_MARKER}`, "partial-markers"],
    ["reversed", `${DAILY_PULSE_END_MARKER}\nold\n${DAILY_PULSE_START_MARKER}`, "reversed-markers"],
    ["duplicate pairs", `${DAILY_PULSE_START_MARKER}\na\n${DAILY_PULSE_END_MARKER}\n${DAILY_PULSE_START_MARKER}\nb\n${DAILY_PULSE_END_MARKER}`, "duplicate-markers"],
    ["duplicate starts", `${DAILY_PULSE_START_MARKER}\na\n${DAILY_PULSE_START_MARKER}\nb\n${DAILY_PULSE_END_MARKER}`, "duplicate-markers"],
  ])("refuses the %s layout with a typed recoverable warning", async (_name, existing, code) => {
    const file = adapter(existing);

    await expect(writeDailyPulse(file, new WriteQueue(), pulse(), [])).rejects.toMatchObject({
      name: "DailyPulseWriteError",
      code,
      recoverable: true,
      warning: expect.any(String),
    } satisfies Partial<DailyPulseWriteError>);
    expect(file.writes).not.toHaveBeenCalled();
    expect(file.content()).toBe(existing);
  });

  it("does not write again when the rendered content is already current", async () => {
    const first = adapter(null);
    await writeDailyPulse(first, new WriteQueue(), pulse(), []);
    const second = adapter(first.content());

    const result = await writeDailyPulse(second, new WriteQueue(), pulse(), []);

    expect(result).toEqual({ path: "_system/review.md", created: false, changed: false });
    expect(second.writes).not.toHaveBeenCalled();
  });

  it("renders deterministic wikilinks and target-specific CTA metadata without executing actions", () => {
    const content = renderDailyPulseBlock(pulse(), []);

    expect(content).toContain("**Morning sync**");
    expect(content).toContain("[[_system/memory/open-loops|Follow up]]");
    expect(content).toContain("[[Active/Projects/Exo|Exo]]");
    expect(content).toContain("Action: [Review automation](obsidian://exo-daily-pulse?target=automation)");
    expect(content).toContain('<!-- exo:daily-pulse:cta {"kind":"review","target":"automation","id":"run-1"} -->');
    expect(content).toContain("Action: [Review suggestion](obsidian://exo-daily-pulse?target=proposal)");
    expect(content).toContain("Action: [Open note](obsidian://exo-daily-pulse?target=note&path=Active%2FProjects%2FExo.md)");
    expect(content).toContain('<!-- exo:daily-pulse:cta {"kind":"review","target":"proposal","id":"proposal-1"} -->');
    expect(content).toBe(renderDailyPulseBlock(pulse(), []));
  });

  it("keeps partial-source warnings compact and non-alarming in the review block", () => {
    const content = renderDailyPulseBlock(pulse(), [
      { source: "loops", message: "Ledger unavailable\ntry later" },
      { source: "budget", message: "Budget unavailable" },
    ]);

    expect(content).toContain("> [!warning]- Partial review");
    expect(content).toContain("> Some sources could not be refreshed; available items are still shown.");
    expect(content).toContain("> - Loops: Ledger unavailable try later");
    expect(content).toContain("> - Budget: Budget unavailable");
  });

  it("escapes marker-shaped source text so a rendered block stays writable", () => {
    const unsafe = pulse();
    unsafe.sections[0].items[0].title = DAILY_PULSE_START_MARKER;
    const content = renderDailyPulseBlock(unsafe, [{
      source: "automations",
      message: DAILY_PULSE_END_MARKER,
    }]);

    expect(content).not.toContain(DAILY_PULSE_START_MARKER);
    expect(content).not.toContain(DAILY_PULSE_END_MARKER);
    expect(content).toContain("&lt;!-- exo:daily-pulse:start --&gt;");
    expect(content).toContain("&lt;!-- exo:daily-pulse:end --&gt;");
  });

  it("propagates adapter write failures without reporting success", async () => {
    const failure = new Error("disk unavailable");
    const file: DailyPulseFileAdapter = {
      read: async () => null,
      write: async () => { throw failure; },
    };

    await expect(writeDailyPulse(file, new WriteQueue(), pulse(), [])).rejects.toBe(failure);
  });

  it("serializes concurrent read-modify-write operations through the injected queue", async () => {
    let content = "Manual";
    let releaseFirst: (() => void) | undefined;
    let reads = 0;
    const file: DailyPulseFileAdapter = {
      read: async () => {
        reads += 1;
        if (reads === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return content;
      },
      write: async (_path, next) => { content = next; },
    };
    const queue = new WriteQueue();
    const firstPulse = pulse();
    const secondPulse = { ...pulse(), generatedAt: NOW + 1_000 };

    const first = writeDailyPulse(file, queue, firstPulse, []);
    const second = writeDailyPulse(file, queue, secondPulse, []);
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(reads).toBe(2);
    expect(content.match(new RegExp(DAILY_PULSE_START_MARKER, "g"))).toHaveLength(1);
    expect(content).toContain("2026-07-20T08:00:01.000Z");
  });
});
