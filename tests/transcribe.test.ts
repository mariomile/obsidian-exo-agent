import { describe, it, expect } from "vitest";
import {
  audioExtension,
  buildMultipart,
  spliceDictation,
  transcribe,
  TranscribeError,
  DEFAULT_TRANSCRIBE_ENDPOINT,
  encodeWav,
  toMono16k,
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
  it("posts WAV to the local Parlo endpoint by default, no key, no model", async () => {
    const { fn, seen } = fake(200, JSON.stringify({ text: "  ciao Exo  " }));
    const out = await transcribe(fn, { audio, mimeType: "audio/wav" });
    expect(out).toBe("ciao Exo");
    const req = seen[0];
    expect(req.url).toBe(DEFAULT_TRANSCRIBE_ENDPOINT);
    expect(req.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = decode(req.body);
    expect(body).toContain('filename="dictation.wav"');
    expect(body).toContain("Content-Type: audio/wav\r\n");
    expect(body).not.toContain('name="model"');
    expect(body).not.toContain('name="language"');
  });

  it("honours a custom endpoint, key, model and language", async () => {
    const { fn, seen } = fake(200, JSON.stringify({ text: "x" }));
    await transcribe(fn, {
      endpoint: " http://localhost:9000/v1/audio/transcriptions ", apiKey: " k ",
      audio, mimeType: "audio/wav", language: "IT", model: "parakeet-v3",
    });
    expect(seen[0].url).toBe("http://localhost:9000/v1/audio/transcriptions");
    expect(seen[0].headers.Authorization).toBe("Bearer k");
    const body = decode(seen[0].body);
    expect(body).toContain('name="language"\r\n\r\nit\r\n');
    expect(body).toContain('name="model"\r\n\r\nparakeet-v3\r\n');
  });

  it("returns empty for an empty clip without calling the server", async () => {
    const { fn, seen } = fake(200, "{}");
    expect(await transcribe(fn, { audio: new ArrayBuffer(0), mimeType: "audio/wav" })).toBe("");
    expect(seen).toHaveLength(0);
  });

  it("names an unreachable server and suggests Parlo", async () => {
    const fn: TranscribeFetch = async () => { throw new Error("ECONNREFUSED"); };
    await expect(transcribe(fn, { audio, mimeType: "audio/wav" })).rejects.toThrow(/Is Parlo running\?/);
  });

  it("surfaces the server's error message and status", async () => {
    const { fn } = fake(503, JSON.stringify({ error: { message: "Model still loading." } }));
    await expect(transcribe(fn, { audio, mimeType: "audio/wav" })).rejects.toMatchObject({
      status: 503,
      message: "transcription failed (503): Model still loading.",
    });
    await expect(transcribe(fn, { audio, mimeType: "audio/wav" })).rejects.toBeInstanceOf(TranscribeError);
  });
});

describe("toMono16k + encodeWav", () => {
  it("averages channels and resamples 48k to 16k", () => {
    const l = new Float32Array(480).fill(0.5);
    const r = new Float32Array(480).fill(-0.5);
    const out = toMono16k([l, r], 48000);
    expect(out.length).toBe(160);
    expect(Array.from(out).every((x) => Math.abs(x) < 1e-6)).toBe(true);
  });
  it("writes a valid 16-bit mono WAV header and clamps samples", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 16000));
    const tag = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(16000);
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.getInt16(46, true)).toBe(0x7fff);
    expect(wav.getInt16(48, true)).toBe(-0x8000);
    expect(wav.getInt16(50, true)).toBe(0x7fff);
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
