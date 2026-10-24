import { describe, it, expect } from "vitest";
import { restoreQueue, serializeQueue, type QueuedMessage } from "../src/core/queue";

const img = { mediaType: "image/png", dataB64: "eA==" };

describe("serializeQueue", () => {
  it("keeps text, context, agent, research mode and prefix", () => {
    const q: QueuedMessage[] = [
      {
        text: "one",
        context: { paths: ["A.md"], selection: { text: "sel", path: "A.md" } },
        agent: "writer",
        researchMode: { enabled: true, startedAt: 5 },
        sendPrefix: "recap",
      },
    ];
    expect(serializeQueue(q)).toEqual(q);
  });

  it("never persists a recovery retry: it drains in the same tick and must not come back as a pill", () => {
    expect(serializeQueue([{ text: "recap retry", sendPrefix: "recap", isRecoveryRetry: true }, { text: "kept" }])).toEqual([{ text: "kept" }]);
  });

  it("drops images (history does not persist them), held and editing", () => {
    const out = serializeQueue([{ text: "a", images: [img], held: true, editing: true }]);
    expect(out).toEqual([{ text: "a" }]);
  });

  it("drops a message that was only images (nothing left to send)", () => {
    expect(serializeQueue([{ text: "", images: [img] }, { text: "  " }, { text: "kept" }])).toEqual([{ text: "kept" }]);
  });

  it("does not alias the live objects", () => {
    const q: QueuedMessage[] = [{ text: "a", context: { paths: ["A.md"], selection: null } }];
    const out = serializeQueue(q);
    out[0].context!.paths.push("B.md");
    expect(q[0].context!.paths).toEqual(["A.md"]);
  });
});

describe("restoreQueue", () => {
  it("brings every item back held, so nothing auto-sends after a reload", () => {
    const out = restoreQueue([{ text: "a" }, { text: "b", agent: "x", editing: true, held: false }]);
    expect(out).toEqual([
      { text: "a", held: true },
      { text: "b", agent: "x", held: true },
    ]);
    expect(out.some((q) => q.editing)).toBe(false);
  });

  it("round-trips a serialized queue", () => {
    const q: QueuedMessage[] = [
      { text: "one", context: { paths: ["A.md"], selection: null }, sendPrefix: "p", researchMode: { enabled: true, startedAt: 1 } },
    ];
    expect(restoreQueue(serializeQueue(q))).toEqual([{ ...q[0], held: true }]);
  });

  it("tolerates missing, malformed and hostile data", () => {
    expect(restoreQueue(undefined)).toEqual([]);
    expect(restoreQueue("nope")).toEqual([]);
    expect(restoreQueue([null, 3, { text: 4 }, { text: "" }, { text: "ok", context: { paths: "x" }, agent: 7 }])).toEqual([
      { text: "ok", held: true },
    ]);
  });
});
