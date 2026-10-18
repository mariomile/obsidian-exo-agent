import { Modal, setIcon, type App, type Component } from "obsidian";
import { previewDocument, type UiPreviewLanguage } from "../core/ui-preview";
import { isolateActivation } from "./dom";

export interface UiPreviewOptions {
  title?: string;
  language?: UiPreviewLanguage;
  initiallyOpen?: boolean;
}

export interface UiPreview {
  update(source: string): void;
  dispose(): void;
}

/** One owned preview, with a shared source for the inline and expanded views. */
export function mountUiPreview(
  app: App,
  owner: Component,
  parent: HTMLElement,
  source: string,
  options: UiPreviewOptions = {},
): UiPreview {
  const language = options.language ?? "html";
  const title = options.title ?? `${language.toUpperCase()} preview`;
  let currentSource = source;
  let disposed = false;
  let modal: Modal | null = null;
  let expanded: { refresh(): void; dispose(): void } | null = null;

  function createSurface(container: HTMLElement, initiallyOpen: boolean, inModal: boolean) {
    const root = container.createDiv({ cls: "mva-ui-preview" });
    const toolbar = root.createDiv({ cls: "mva-ui-preview-toolbar" });
    isolateActivation(toolbar);
    const previewButton = toolbar.createEl("button", {
      cls: "mva-btn",
      text: "Preview",
      attr: { type: "button", "aria-label": "Show interactive preview" },
    });
    const codeButton = toolbar.createEl("button", {
      cls: "mva-btn",
      text: "Code",
      attr: { type: "button", "aria-label": "Show preview source code" },
    });
    toolbar.createDiv({ cls: "mva-spacer" });
    const reloadButton = toolbar.createEl("button", {
      cls: "mva-icon-btn",
      attr: { type: "button", "aria-label": "Reload preview", title: "Reload preview" },
    });
    setIcon(reloadButton, "rotate-cw");
    if (!inModal) {
      const expandButton = toolbar.createEl("button", {
        cls: "mva-icon-btn",
        attr: { type: "button", "aria-label": "Expand preview", title: "Expand preview" },
      });
      setIcon(expandButton, "maximize-2");
      expandButton.onclick = openExpanded;
    }
    const body = root.createDiv({ cls: "mva-ui-preview-body" });
    const codeBlock = body.createEl("pre", {
      cls: "mva-ui-preview-code",
      attr: { tabindex: "0", "aria-label": "Preview source code" },
    });
    const code = codeBlock.createEl("code");
    const empty = body.createDiv({ cls: "mva-ui-preview-empty", text: "No content to preview yet." });
    root.createDiv({
      cls: "mva-ui-preview-note",
      text: "Self-contained HTML/CSS/JS. External assets and API requests are blocked.",
    });
    let showingPreview = initiallyOpen;
    let frame: HTMLIFrameElement | null = null;
    let surfaceDisposed = false;

    function removeFrame(): void {
      frame?.remove();
      frame = null;
    }

    function refresh(): void {
      if (surfaceDisposed) return;
      const hasContent = currentSource.trim().length > 0;
      code.textContent = currentSource;
      codeBlock.hidden = showingPreview;
      empty.hidden = !showingPreview || hasContent;
      previewButton.setAttribute("aria-pressed", String(showingPreview));
      codeButton.setAttribute("aria-pressed", String(!showingPreview));
      reloadButton.disabled = !showingPreview || !hasContent;
      if (!showingPreview || !hasContent) {
        removeFrame();
        return;
      }
      if (!frame) {
        frame = body.createEl("iframe", {
          cls: "mva-ui-preview-iframe",
          attr: { sandbox: "allow-scripts", title, referrerpolicy: "no-referrer" },
        });
      }
      frame.srcdoc = previewDocument(currentSource, language);
    }

    function selectPreview(next: boolean): void {
      if (showingPreview === next || surfaceDisposed) return;
      showingPreview = next;
      refresh();
    }

    previewButton.onclick = () => selectPreview(true);
    codeButton.onclick = () => selectPreview(false);
    reloadButton.onclick = refresh;
    refresh();
    return {
      refresh,
      dispose() {
        if (surfaceDisposed) return;
        surfaceDisposed = true;
        removeFrame();
        root.remove();
      },
    };
  }

  function openExpanded(): void {
    if (disposed || modal) return;
    const nextModal = new Modal(app);
    modal = nextModal;
    nextModal.modalEl.addClass("mva-ui-preview-modal");
    nextModal.titleEl.setText(title);
    nextModal.onOpen = () => {
      expanded = createSurface(nextModal.contentEl, true, true);
    };
    nextModal.onClose = () => {
      expanded?.dispose();
      expanded = null;
      modal = null;
    };
    nextModal.open();
  }

  const inline = createSurface(parent, options.initiallyOpen ?? false, false);
  const result: UiPreview = {
    update(nextSource) {
      if (disposed || nextSource === currentSource) return;
      currentSource = nextSource;
      inline.refresh();
      expanded?.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      modal?.close();
      inline.dispose();
    },
  };
  owner.register(() => result.dispose());
  return result;
}
