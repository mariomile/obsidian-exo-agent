import { describe, it, expect } from "vitest";
import { memoTtl } from "../src/core/ttl-memo";

describe("memoTtl", () => {
  it("runs the function once inside the window", async () => {
    let calls = 0;
    let t = 1000;
    const get = memoTtl(async () => ++calls, 60_000, () => t);
    expect(await get()).toBe(1);
    t += 59_999;
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
  });

  it("runs it again once the window has passed", async () => {
    let calls = 0;
    let t = 1000;
    const get = memoTtl(async () => ++calls, 60_000, () => t);
    await get();
    t += 60_000;
    expect(await get()).toBe(2);
  });

  it("shares one in-flight call between concurrent callers", async () => {
    let calls = 0;
    const get = memoTtl(async () => ++calls, 60_000, () => 0);
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
  });

  it("does not cache a rejection", async () => {
    let calls = 0;
    const get = memoTtl(async () => {
      if (++calls === 1) throw new Error("boom");
      return calls;
    }, 60_000, () => 0);
    await expect(get()).rejects.toThrow("boom");
    expect(await get()).toBe(2);
  });
});
