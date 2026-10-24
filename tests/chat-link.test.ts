import { describe, it, expect } from "vitest";
import { chatLink, parseChatLink } from "../src/core/chat-link";

describe("chat link", () => {
  it("round-trips id and message index", () => {
    const url = new URL(chatLink("c-1 x", 7));
    expect(url.protocol).toBe("obsidian:");
    const params = Object.fromEntries(url.searchParams);
    expect(parseChatLink(params)).toEqual({ convoId: "c-1 x", msgIndex: 7 });
  });

  it("rejects a link without an id", () => {
    expect(parseChatLink({ msg: "3" })).toBeNull();
    expect(parseChatLink({ id: "  " })).toBeNull();
  });

  it("opens the chat when msg is missing or not a valid index", () => {
    expect(parseChatLink({ id: "a" })).toEqual({ convoId: "a", msgIndex: null });
    expect(parseChatLink({ id: "a", msg: "-1" })).toEqual({ convoId: "a", msgIndex: null });
    expect(parseChatLink({ id: "a", msg: "x" })).toEqual({ convoId: "a", msgIndex: null });
  });
});
