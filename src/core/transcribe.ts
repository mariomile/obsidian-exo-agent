/**
 * Speech to text for composer dictation: one recorded clip in, plain text out,
 * through OpenAI's `/v1/audio/transcriptions` endpoint.
 *
 * Deliberately Obsidian-free: the plugin passes a `requestUrl` adapter (desktop
 * CSP and proxy safe), tests pass a fake. The multipart body is built by hand
 * because `requestUrl` takes a string or ArrayBuffer, not FormData.
 */

export const TRANSCRIBE_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** Models the setting offers. The first is the default: cheapest and fast,
 *  accurate enough for dictating a prompt. */
export const TRANSCRIBE_MODELS = [
  { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe (fast, cheapest)" },
  { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe (most accurate)" },
  { id: "whisper-1", label: "Whisper" },
] as const;

export const DEFAULT_TRANSCRIBE_MODEL = TRANSCRIBE_MODELS[0].id;

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
  apiKey: string;
  audio: ArrayBuffer;
  /** MIME type of the clip, e.g. `audio/webm;codecs=opus`. */
  mimeType: string;
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
 *  `TranscribeError` on a missing key, an HTTP error or an unreadable reply. */
export async function transcribe(fetchFn: TranscribeFetch, opts: TranscribeOptions): Promise<string> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new TranscribeError("No OpenAI API key set for dictation.");
  if (opts.audio.byteLength === 0) return "";

  const fields: Record<string, string> = {
    model: opts.model?.trim() || DEFAULT_TRANSCRIBE_MODEL,
    response_format: "json",
  };
  const language = opts.language?.trim().toLowerCase();
  if (language) fields.language = language;

  const boundary = `----exo-dictation-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = buildMultipart(
    fields,
    { name: `dictation.${audioExtension(opts.mimeType)}`, mimeType: opts.mimeType, data: opts.audio },
    boundary,
  );

  const res = await fetchFn({
    url: TRANSCRIBE_ENDPOINT,
    method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    throw: false,
  });

  if (res.status < 200 || res.status >= 300) {
    const detail = apiErrorMessage(res.text);
    if (res.status === 401) throw new TranscribeError("OpenAI rejected the API key (401).", 401);
    throw new TranscribeError(
      `Transcription failed (${res.status})${detail ? `: ${detail}` : "."}`,
      res.status,
    );
  }

  try {
    const parsed = JSON.parse(res.text) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    throw new TranscribeError("Transcription reply was not valid JSON.");
  }
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
