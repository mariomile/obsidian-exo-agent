import { describe, it, expect } from "vitest";
import { MAX_AGENT_HOPS, nextHop, formatChatTranscript, planSend } from "../src/core/delegation";

describe("planSend", () => {
  it("an idle chat runs the message now, whatever the mode", () => {
    for (const m of ["auto", "queue", "steer"] as const) expect(planSend(m, false, true)).toBe("sent");
  });
  it("a busy chat queues, unless steer is asked and possible", () => {
    expect(planSend("auto", true, true)).toBe("queued");
    expect(planSend("queue", true, true)).toBe("queued");
    expect(planSend("steer", true, true)).toBe("steered");
    expect(planSend("steer", true, false)).toBe("queued");
  });
  it("a turn still in its preamble counts as busy, so the message is queued, not lost", () => {
    for (const m of ["auto", "queue", "steer"] as const) expect(planSend(m, false, true, true)).toBe("queued");
  });
});

describe("formatChatTranscript", () => {
  it("keeps the newest messages under the cap and says what it cut", () => {
    const messages = [
      { role: "user" as const, text: "x".repeat(3000) },
      { role: "assistant" as const, segments: [{ t: "text" as const, md: "answer" }] },
      { role: "user" as const, text: "latest ask" },
    ];
    const out = formatChatTranscript({ id: "c1", title: "Pricing", messages }, 1000);
    expect(out).toBe("Pricing (id c1)\n\n[Earlier messages omitted]\n\nASSISTANT: answer\n\nUSER: latest ask");
  });
});

describe("nextHop (send_to_chat loop guard)", () => {
  it("allows a chain up to the cap, then refuses, even if every send is approved", () => {
    const depths = new Map<string, number>();
    let from = "A";
    const hops: (number | null)[] = [];
    for (let i = 0; i < MAX_AGENT_HOPS + 1; i++) {
      const to = from === "A" ? "B" : "A";
      const h = nextHop(depths, from);
      hops.push(h);
      if (h !== null) depths.set(to, h);
      from = to;
    }
    expect(hops).toEqual([1, 2, 3, null]);
  });
  it("a chat the user just wrote in starts again from zero", () => {
    const depths = new Map([["A", 3]]);
    expect(nextHop(depths, "A")).toBeNull();
    depths.delete("A");
    expect(nextHop(depths, "A")).toBe(1);
  });
});
