import { Notice, requestUrl, setIcon, setTooltip } from "obsidian";
import type ExoPlugin from "../main";
import { encodeWav, spliceDictation, toMono16k, transcribe, TranscribeError, type TranscribeFetch } from "../core/transcribe";
import { chatView } from "./convo-bridge";

/**
 * Composer dictation: a mic button beside Send. Click to record, click again
 * (or Esc to cancel); the clip is converted to 16 kHz mono WAV, sent to a LOCAL
 * transcription server (Parlo by default) and the text lands at the caret,
 * unsent, so the user can still edit it. Off unless `dictationEnabled`.
 *
 * Desktop only, like the plugin. Recording uses the renderer's MediaRecorder;
 * the first use triggers the macOS microphone prompt for Obsidian.
 */

type DictationState = "idle" | "recording" | "transcribing";

/** The palette command: reveal the chat and start or stop dictating. */
export function registerDictationCommand(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "toggle-dictation",
    name: "Dictate into the chat (start / stop)",
    callback: async () => {
      await plugin.activateView();
      void chatView(plugin.app)?.composer.dictation?.toggle();
    },
  });
}

/** Pick a recorder format the renderer supports. Opus in WebM is Chromium's
 *  native choice; it is decoded and re-encoded as WAV before upload. */
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

const obsidianFetch: TranscribeFetch = async (req) => {
  const res = await requestUrl(req);
  return { status: res.status, text: res.text };
};

export class Dictation {
  private state: DictationState = "idle";
  private btn!: HTMLButtonElement;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private cancelled = false;

  /** `input` is the composer textarea; `setValue` must re-run its autogrow. */
  constructor(
    private plugin: ExoPlugin,
    private input: HTMLTextAreaElement,
    private setValue: (v: string) => void,
    register: (cb: () => void) => void,
  ) {
    register(() => this.cancel());
    // Capture phase, so Esc while recording cancels the clip and never also
    // reaches the composer's own Esc (stop the streaming turn).
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.state !== "recording") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
    }, { capture: true });
  }

  /** Mount the mic button into the toolbar, before Send. */
  mount(toolbar: HTMLElement): void {
    this.btn = toolbar.createEl("button", {
      cls: "mva-icon-btn mva-dictate",
      attr: { "aria-label": "Dictate", "aria-pressed": "false" },
    });
    this.btn.onclick = () => void this.toggle();
    this.render();
  }

  /** Put the transcript at the caret (replacing any selection), spaced so it
   *  never glues onto a neighbouring word. Never sends. */
  private insert(text: string): void {
    const el = this.input;
    const start = el.selectionStart ?? el.value.length;
    const next = spliceDictation(el.value, start, el.selectionEnd ?? start, text);
    this.setValue(next.value);
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
  }

  /** Show or hide the button after the setting flips; stops a live clip. */
  refresh(): void {
    if (!this.plugin.settings.dictationEnabled) this.cancel();
    this.render();
  }

  /** Recorded clip (any Chromium format) to 16 kHz mono WAV. */
  private async toWav(blob: Blob): Promise<ArrayBuffer> {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const chans = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      return encodeWav(toMono16k(chans, decoded.sampleRate), 16000);
    } finally {
      void ctx.close();
    }
  }

  /** Start, or stop and transcribe. Ignored while a clip is being transcribed. */
  async toggle(): Promise<void> {
    if (this.state === "recording") return this.stop();
    if (this.state === "idle") return this.start();
  }

  /** Stop without transcribing (Esc, view closed). */
  cancel(): void {
    if (this.state !== "recording") return;
    this.cancelled = true;
    this.recorder?.stop();
  }

  private async start(): Promise<void> {
    if (!this.plugin.settings.dictationEnabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      new Notice("Dictation isn't available here: this device can't record audio.");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      new Notice(
        denied
          ? "Microphone access is blocked. Allow Obsidian in System Settings > Privacy & Security > Microphone, then restart Obsidian."
          : "Couldn't open the microphone.",
        8000,
      );
      return;
    }
    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
    this.recorder = recorder;
    this.chunks = [];
    this.cancelled = false;
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.onstop = () => void this.finish(recorder.mimeType || mimeType || "audio/webm");
    recorder.start();
    this.setState("recording");
  }

  private stop(): void {
    this.recorder?.stop();
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }

  private async finish(mimeType: string): Promise<void> {
    this.releaseMic();
    const chunks = this.chunks;
    this.chunks = [];
    if (this.cancelled || chunks.length === 0) {
      this.setState("idle");
      return;
    }
    this.setState("transcribing");
    try {
      const audio = await this.toWav(new Blob(chunks, { type: mimeType }));
      const s = this.plugin.settings;
      const text = await transcribe(obsidianFetch, {
        endpoint: s.dictationEndpoint, apiKey: s.dictationApiKey, model: s.dictationModel,
        language: s.dictationLanguage, audio, mimeType: "audio/wav",
      });
      if (text) this.insert(text);
      else new Notice("Dictation: no speech recognised.");
    } catch (e) {
      const msg = e instanceof TranscribeError ? e.message : "couldn't decode or send the recording.";
      new Notice(`Dictation: ${msg}`, 8000);
    } finally {
      this.setState("idle");
    }
  }

  private setState(s: DictationState): void {
    this.state = s;
    this.render();
  }

  private render(): void {
    if (!this.btn) return;
    this.btn.toggle(this.plugin.settings.dictationEnabled);
    const s = this.state;
    this.btn.toggleClass("is-recording", s === "recording");
    this.btn.toggleClass("is-busy", s === "transcribing");
    this.btn.setAttribute("aria-pressed", String(s === "recording"));
    this.btn.disabled = s === "transcribing";
    setIcon(this.btn, s === "recording" ? "square" : s === "transcribing" ? "loader" : "mic");
    const tip = s === "recording" ? "Stop and transcribe" : s === "transcribing" ? "Transcribing…" : "Dictate";
    setTooltip(this.btn, tip);
    this.btn.setAttribute("aria-label", tip);
  }
}
