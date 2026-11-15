/**
 * Speech to text for composer dictation: one recorded clip in, plain text out,
 * through a LOCAL transcription server that speaks the OpenAI
 * `/v1/audio/transcriptions` format (Parlo's on-device engine by default, or
 * any compatible local server). Nothing goes to a cloud API unless the user
 * points the endpoint there.
 *
 * Deliberately Obsidian-free: the plugin passes a `requestUrl` adapter (desktop
 * CSP and proxy safe), tests pass a fake. The multipart body is built by hand
 * because `requestUrl` takes a string or ArrayBuffer, not FormData.
 */

/** Parlo's local endpoint (127.0.0.1 only, never the network). */
export const DEFAULT_TRANSCRIBE_ENDPOINT = "http://127.0.0.1:47821/v1/audio/transcriptions";

export interface TranscribeRequest {
  url: string;
  method: "POST";
  contentType: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  throw: false;
}

export interface TranscribeResponse {
  status: number;
  text: string;
}

export type TranscribeFetch = (req: TranscribeRequest) => Promise<TranscribeResponse>;

export interface TranscribeOptions {
  /** Full URL of the transcriptions endpoint. Empty uses Parlo's. */
  endpoint?: string;
  /** Bearer token, only for a server that wants one. Local Parlo doesn't. */
  apiKey?: string;
  audio: ArrayBuffer;
  /** MIME type of the clip, e.g. `audio/wav`. */
  mimeType: string;
  /** Model id the server should use. Empty lets the server use its active one. */
  model?: string;
  /** ISO-639-1 code ("it", "en"). Empty lets the model detect it. */
  language?: string;
}

export class TranscribeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TranscribeError";
  }
}

/** File extension the endpoint expects for a recorder MIME type. The API
 *  sniffs the format from the file name, so this must match the bytes. */
export function audioExtension(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base === "audio/webm" || base === "video/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4" || base === "audio/m4a" || base === "audio/x-m4a") return "m4a";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav" || base === "audio/wave") return "wav";
  return "webm";
}

/** Build the multipart/form-data body. Returns the bytes and the boundary. */
export function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; mimeType: string; data: ArrayBuffer },
  boundary: string,
): ArrayBuffer {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.mimeType.split(";")[0]}\r\n\r\n`,
    ),
  );
  chunks.push(new Uint8Array(file.data));
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/** The API's error message, if the body is the usual `{ error: { message } }`. */
function apiErrorMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const m = parsed?.error?.message;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}

/** Transcribe one clip. Resolves to the trimmed text ("" for silence); throws
 *  `TranscribeError` on an unreachable server, an HTTP error or a bad reply. */
export async function transcribe(fetchFn: TranscribeFetch, opts: TranscribeOptions): Promise<string> {
  if (opts.audio.byteLength === 0) return "";
  const url = opts.endpoint?.trim() || DEFAULT_TRANSCRIBE_ENDPOINT;

  const fields: Record<string, string> = { response_format: "json" };
  const model = opts.model?.trim();
  if (model) fields.model = model;
  const language = opts.language?.trim().toLowerCase();
  if (language) fields.language = language;

  const boundary = `----exo-dictation-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = buildMultipart(
    fields,
    { name: `dictation.${audioExtension(opts.mimeType)}`, mimeType: opts.mimeType, data: opts.audio },
    boundary,
  );
  const headers: Record<string, string> = {};
  const apiKey = opts.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res: TranscribeResponse;
  try {
    res = await fetchFn({
      url,
      method: "POST",
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers,
      body,
      throw: false,
    });
  } catch {
    throw new TranscribeError(`can't reach the transcription server at ${url}. Is Parlo running?`);
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = apiErrorMessage(res.text);
    throw new TranscribeError(`transcription failed (${res.status})${detail ? `: ${detail}` : "."}`, res.status);
  }

  try {
    const parsed = JSON.parse(res.text) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    throw new TranscribeError("the transcription reply was not valid JSON.");
  }
}

/** Mix to mono and resample to `rate` Hz by linear interpolation. Speech
 *  models want 16 kHz mono; doing it here keeps uploads ~10x smaller than the
 *  48 kHz stereo the mic delivers. */
export function toMono16k(channels: Float32Array[], inRate: number, rate = 16000): Float32Array {
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  if (inRate === rate || n === 0) return mono;
  const outLen = Math.max(1, Math.round((n * rate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / rate;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.min(n - 1, Math.floor(x));
    const i1 = Math.min(n - 1, i0 + 1);
    out[i] = mono[i0] + (mono[i1] - mono[i0]) * (x - i0);
  }
  return out;
}

/** 16-bit PCM WAV: the one format every local engine (AVFoundation, whisper.cpp,
 *  FluidAudio) reads without a decoder. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Join dictated text onto a draft at the caret: a space before it unless the
 *  draft is empty or already ends in whitespace, a space after it unless the
 *  rest already starts with one. Returns the new value and caret position. */
export function spliceDictation(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + text + trail;
  return { value: before + inserted + after, caret: before.length + lead.length + text.length };
}
