import { Setting } from "obsidian";
import type ExoPlugin from "../main";
import { TRANSCRIBE_MODELS, DEFAULT_TRANSCRIBE_MODEL } from "../core/transcribe";

/** The Chat tab's Dictation section: key, model, language. Free function, like
 *  `ui/settings-cli.ts`, because it reads nothing but `plugin.settings`. */
export function renderDictationSettings(el: HTMLElement, plugin: ExoPlugin): void {
  const s = plugin.settings;
  new Setting(el)
    .setName("Dictation")
    .setDesc(
      "The mic button beside Send records your voice and types the transcript into the composer, unsent. Audio goes to OpenAI's transcription API with your own key (GPT-4o mini Transcribe costs about $0.003 per minute)."
    )
    .setHeading();
  new Setting(el)
    .setName("OpenAI API key")
    .setDesc("Stored in this plugin's data.json on this device. Create one at platform.openai.com/api-keys.")
    .addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-...")
        .setValue(s.dictationApiKey)
        .onChange(async (v) => {
          s.dictationApiKey = v.trim();
          await plugin.saveSettings();
        });
    });
  new Setting(el).setName("Transcription model").addDropdown((d) => {
    for (const m of TRANSCRIBE_MODELS) d.addOption(m.id, m.label);
    d.setValue(s.dictationModel || DEFAULT_TRANSCRIBE_MODEL).onChange(async (v) => {
      s.dictationModel = v;
      await plugin.saveSettings();
    });
  });
  new Setting(el)
    .setName("Language")
    .setDesc("Two-letter code such as it or en. Setting it improves accuracy and speed; empty detects the language.")
    .addText((t) =>
      t
        .setPlaceholder("auto")
        .setValue(s.dictationLanguage)
        .onChange(async (v) => {
          s.dictationLanguage = v.trim().toLowerCase();
          await plugin.saveSettings();
        })
    );
}
