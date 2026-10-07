import { describe, expect, it } from "vitest";
import { forkMessages } from "../src/core/fork";
import type { Message } from "../src/core/model";

const chat: Message[] = [
  { role: "user", text: "one" },
  { role: "assistant", segments: [{ t: "text", md: "first" }], checkpointRef: "refs/exo/x" },
  { role: "user", text: "two" },
  { role: "assistant", segments: [{ t: "text", md: "second" }] },
];

describe("forkMessages", () => {
  it("keeps the history up to and including the message", () => {
    const f = forkMessages(chat, 1);
    expect(f).toHaveLength(2);
    expect(f[1]).toEqual({ role: "assistant", segments: [{ t: "text", md: "first" }] });
  });

  it("takes the whole chat without an index or out of range", () => {
    expect(forkMessages(chat)).toHaveLength(4);
    expect(forkMessages(chat, 9)).toHaveLength(4);
  });

  it("copies, so the original never changes with the fork", () => {
    const f = forkMessages(chat, 3);
    (f[3] as Extract<Message, { role: "assistant" }>).segments.push({ t: "text", md: "x" });
    (f[0] as Extract<Message, { role: "user" }>).text = "changed";
    expect((chat[3] as Extract<Message, { role: "assistant" }>).segments).toHaveLength(1);
    expect((chat[0] as Extract<Message, { role: "user" }>).text).toBe("one");
  });
});
