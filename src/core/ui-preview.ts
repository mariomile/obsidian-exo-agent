export type UiPreviewLanguage = "html" | "svg";

/** Inline programs run in an opaque-origin iframe without an app bridge. */
const PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Put the policy before all supplied content, including complete documents. */
export function previewDocument(source: string, language: UiPreviewLanguage): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${language.toUpperCase()} preview</title>
<style>html{color-scheme:light}body{margin:0;background:white;color:black;font-family:system-ui,sans-serif}${language === "svg" ? "body>svg{max-width:100%;height:auto}" : ""}</style>
</head><body>${source}</body></html>`;
}
