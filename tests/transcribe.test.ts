import { describe, it, expect } from "vitest";
import {
  audioExtension,
  buildMultipart,
  spliceDictation,
  transcribe,
  TranscribeError,
  TRANSCRIBE_ENDPOINT,
  DEFAULT_TRANSCRIBE_MODEL,
  type TranscribeFetch,
  type TranscribeRequest,
} from "../src/core/transcribe";

const audio = new Uint8Array([1, 2, 3, 4]).buffer;

function fake(status: number, text: string) {
  const seen: TranscribeRequest[] = [];
  const fn: TranscribeFetch = async (req) => {
    seen.push(req);
    return { status, text };
  };
  return { fn, seen };
}

const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);

describe("transcribe", () => {
  it("posts multipart audio with the key and default model, returns trimmed text", async () => {
    const { fn, seen } = fake(200, JSON.stringify({ text: "  ciao Exo  " }));
    const out = await transcribe(fn, { apiKey: " sk-test ", audio, mimeType: "audio/webm;codecs=opus" });
    expect(out).toBe("ciao Exo");
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.url).toBe(TRANSCRIBE_ENDPOINT);
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = decode(req.body);
    expect(body).toContain(`name="model"\r\n\r\n${DEFAULT_TRANSCRIBE_MODEL}\r\n`);
    expect(body).toContain('filename="dictation.webm"');
    expect(body).toContain("Content-Type: audio/webm\r\n");
    expect(body).not.toContain('name="language"');
  });

  it("sends the language when set", async () => {
    const { fn, seen } = fake(200, JSON.stringify({ text: "x" }));
    await transcribe(fn, { apiKey: "k", audio, mimeType: "audio/webm", language: "IT", model: "gpt-4o-transcribe" });
    const body = decode(seen[0].body);
    expect(body).toContain('name="language"\r\n\r\nit\r\n');
    expect(body).toContain('name="model"\r\n\r\ngpt-4o-transcribe\r\n');
  });

  it("refuses without a key and never calls the network", async () => {
    const { fn, seen } = fake(200, "{}");
    await expect(transcribe(fn, { apiKey: "  ", audio, mimeType: "audio/webm" })).rejects.toBeInstanceOf(TranscribeError);
    expect(seen).toHaveLength(0);
  });

  it("returns empty for an empty clip without calling the network", async () => {
    const { fn, seen } = fake(200, "{}");
    expect(await transcribe(fn, { apiKey: "k", audio: new ArrayBuffer(0), mimeType: "audio/webm" })).toBe("");
    expect(seen).toHaveLength(0);
  });

  it("surfaces the API error message and status", async () => {
    const { fn } = fake(400, JSON.stringify({ error: { message: "Invalid file format." } }));
    await expect(transcribe(fn, { apiKey: "k", audio, mimeType: "audio/webm" })).rejects.toMatchObject({
      status: 400,
      message: "Transcription failed (400): Invalid file format.",
    });
  });

  it("names a rejected key plainly", async () => {
    const { fn } = fake(401, "nope");
    await expect(transcribe(fn, { apiKey: "k", audio, mimeType: "audio/webm" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("audioExtension", () => {
  it("maps recorder MIME types", () => {
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("audio/mp4")).toBe("m4a");
    expect(audioExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioExtension("")).toBe("webm");
  });
});

describe("buildMultipart", () => {
  it("keeps the binary file bytes intact", () => {
    const data = new Uint8Array([0, 255, 13, 10]).buffer;
    const out = new Uint8Array(buildMultipart({}, { name: "a.webm", mimeType: "audio/webm", data }, "B"));
    const head = new TextEncoder().encode(
      '--B\r\nContent-Disposition: form-data; name="file"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n',
    );
    expect(Array.from(out.slice(head.length, head.length + 4))).toEqual([0, 255, 13, 10]);
    expect(new TextDecoder().decode(out.slice(head.length + 4))).toBe("\r\n--B--\r\n");
  });
});

describe("spliceDictation", () => {
  it("inserts into an empty draft", () => {
    expect(spliceDictation("", 0, 0, "ciao")).toEqual({ value: "ciao", caret: 4 });
  });
  it("adds a space after existing text", () => {
    expect(spliceDictation("hello", 5, 5, "world")).toEqual({ value: "hello world", caret: 11 });
  });
  it("pads both sides in the middle of a word run", () => {
    expect(spliceDictation("ab", 1, 1, "X")).toEqual({ value: "a X b", caret: 3 });
  });
  it("replaces a selection and respects existing whitespace", () => {
    expect(spliceDictation("one two three", 4, 7, "2")).toEqual({ value: "one 2 three", caret: 5 });
  });
});
