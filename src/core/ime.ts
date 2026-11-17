/**
 * True while an IME (Japanese, Chinese, Korean...) is composing text. The Enter
 * that commits a conversion must not send or submit: only a second Enter does.
 * `key === "Process"` covers Chromium/Electron builds where `isComposing` is
 * already false on the committing keydown (the old keyCode 229 signal, without
 * the deprecated property). Reported in issue #56.
 */
export function isComposingKey(e: Pick<KeyboardEvent, "isComposing" | "key">): boolean {
  return e.isComposing || e.key === "Process";
}
