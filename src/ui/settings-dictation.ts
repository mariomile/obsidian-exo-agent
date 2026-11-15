import { Setting } from "obsidian";
import type ExoPlugin from "../main";
import type { MVASettings } from "../settings-schema";
import { DEFAULT_TRANSCRIBE_ENDPOINT } from "../core/transcribe";
import { chatView } from "./convo-bridge";

type TextKey = "dictationEndpoint" | "dictationApiKey" | "dictationModel" | "dictationLanguage";

/** The Chat tab's Dictation section. Free function, like `ui/settings-cli.ts`,
 *  because it reads nothing but `plugin.settings`. */
export function renderDictationSettings(el: HTMLElement, plugin: ExoPlugin): void {
  const s = plugin.settings;
  new Setting(el)
    .setName("Dictation")
    .setDesc(
      "A mic button beside Send: speak, click again, and the transcript lands in the draft, unsent. Transcription runs on this Mac through a local server, Parlo by default, so audio never leaves the device."
    )
    .setHeading();
  const detail = el.createDiv();
  const text = (key: TextKey, name: string, desc: string, placeholder: string, secret = false) =>
    new Setting(detail).setName(name).setDesc(desc).addText((t) => {
      if (secret) t.inputEl.type = "password";
      t.setPlaceholder(placeholder)
        .setValue(s[key])
        .onChange(async (v) => {
          (s as Pick<MVASettings, TextKey>)[key] = key === "dictationLanguage" ? v.trim().toLowerCase() : v.trim();
          await plugin.saveSettings();
        });
    });
  new Setting(el)
    .setName("Enable dictation")
    .setDesc("Off by default. When off there is no mic button and Exo never opens the microphone.")
    .addToggle((t) =>
      t.setValue(s.dictationEnabled).onChange(async (v) => {
        s.dictationEnabled = v;
        detail.toggle(v);
        await plugin.saveSettings();
        chatView(plugin.app)?.composer.dictation?.refresh();
      })
    );
  el.appendChild(detail);
  detail.toggle(s.dictationEnabled);
  text("dictationEndpoint", "Transcription server", "Any local server with the OpenAI /v1/audio/transcriptions format. Empty uses Parlo on this Mac.", DEFAULT_TRANSCRIBE_ENDPOINT);
  text("dictationLanguage", "Language", "Two-letter code such as it or en. Empty detects the language.", "auto");
  text("dictationModel", "Model", "Optional. Empty uses the model active in the server (in Parlo, the one picked in Settings, Models).", "server default");
  text("dictationApiKey", "API key", "Only for a server that requires one. Parlo doesn't.", "none", true);
}
