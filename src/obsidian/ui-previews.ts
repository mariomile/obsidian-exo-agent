import { MarkdownRenderer, type Component, type TFile, type App } from "obsidian";
import { mountUiPreview } from "../ui/ui-preview";
import type { UiPreviewLanguage } from "../core/ui-preview";
import { ownedPreviewComponent, previewTargetAlive } from "./preview-lifecycle";

function codeLanguage(code: HTMLElement): UiPreviewLanguage | null {
  for (const element of [code, code.parentElement]) {
    if (element?.classList.contains("language-html")) return "html";
    if (element?.classList.contains("language-svg")) return "svg";
  }
  return null;
}

export const UI_PREVIEW_PROMPT = "UI previews: When a visual or interactive interface helps, you may include a fenced html or svg block directly in your answer. Exo provides Preview, Code and Expand controls in the chat. Use self-contained HTML with inline CSS and JavaScript, or SVG; external scripts, stylesheets, network calls and local resource paths are unavailable in this preview. Do not use JSX or framework imports. Generated .html, .htm and .svg files also get an interactive preview.";

/** Render only assistant prose through this seam; ordinary notes and user messages stay unchanged. */
export async function renderChatMarkdown(
  app: App, markdown: string, element: HTMLElement, sourcePath: string, owner: Component,
): Promise<void> {
  let disposed = false;
  const targetAlive = previewTargetAlive(element);
  owner.register(() => { disposed = true; });
  await MarkdownRenderer.render(app, markdown, element, sourcePath, owner);
  if (disposed || !targetAlive()) return;
  for (const code of Array.from(element.querySelectorAll<HTMLElement>("pre > code"))) {
    const language = codeLanguage(code);
    const pre = code.parentElement;
    if (!language || !pre || pre.closest(".mva-ui-preview")) continue;
    const source = code.textContent ?? "";
    const container = createDiv();
    pre.replaceWith(container);
    mountUiPreview(app, ownedPreviewComponent(owner, container), container, source, {
      title: language === "svg" ? "SVG preview" : "HTML preview", language,
    });
  }
}

/** One lifecycle owns the iframe, its reads, and vault listeners. No Artifacts plugin required. */
export function mountFileUiPreview(app: App, owner: Component, parent: HTMLElement, file: TFile): void {
  const child = ownedPreviewComponent(owner, parent);
  const status = parent.createDiv({ cls: "mva-faint", text: "Loading preview…" });
  const language = file.extension.toLowerCase() === "svg" ? "svg" : "html";
  const preview = mountUiPreview(app, child, parent, "", {
    title: file.name, language, initiallyOpen: true,
  });
  let disposed = false;
  let revision = 0;
  const read = async (): Promise<void> => {
    const current = ++revision;
    try {
      const source = await app.vault.cachedRead(file);
      if (disposed || current !== revision) return;
      status.setText("");
      preview.update(source);
    } catch {
      if (disposed || current !== revision) return;
      status.setText("Preview unavailable. Open the file to inspect it.");
    }
  };
  child.register(() => { disposed = true; revision++; });
  child.registerEvent(app.vault.on("modify", changed => {
    if (changed === file) void read();
  }));
  child.registerEvent(app.vault.on("delete", deleted => {
    if (deleted !== file || disposed) return;
    revision++;
    preview.update("");
    status.setText("This preview file was deleted.");
  }));
  void read();
}
