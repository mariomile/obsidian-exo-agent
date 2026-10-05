import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Browser wiring contract: the seams that connect the tested browser core to
 * the untestable view.ts. Same rationale as fanout-wiring.test.ts: every link
 * is a plain call whose failure mode is silence. A session that never receives
 * the bridge simply has no browser tools; a session signature that ignores
 * `browserEnabled` keeps serving stale tool lists after the flag flips.
 * Red here means "re-wire the seam", never "relax the assertion".
 */
const read = (...rel: string[]): string => readFileSync(join(__dirname, "..", ...rel), "utf8");
const view = read("src", "view.ts");
const tools = read("src", "obsidian", "tools.ts");
const controller = read("src", "obsidian", "browser-controller.ts");
const host = read("src", "obsidian", "browser-host.ts");
const registry = read("src", "ui", "view-registry.ts");
const styles = read("styles.css");

describe("browser wiring", () => {
  it("view.ts puts a per-convo browser bridge in the session's tool options", () => {
    expect(view).toMatch(/browserBridge:\s*browserBridgeFor\(this\.plugin,\s*c\.id\)/);
  });

  it("the same tool options feed the Claude server and the Codex registry", () => {
    expect(view).toMatch(/createObsidianToolServer\(this\.app,\s*toolOpts\)/);
    expect(view).toMatch(/buildObsidianTools\(this\.app,\s*\{\s*\.\.\.toolOpts,/);
  });

  it("tools.ts registers the browser set only behind the bridge", () => {
    expect(tools).toMatch(/browserBridge \? buildBrowserTools\(browserBridge\) : \[\]/);
  });

  it("every entry point waits for readiness: the wait sits inside ensureView", () => {
    const at = controller.indexOf("private async ensureView");
    expect(at).toBeGreaterThan(-1);
    const body = controller.slice(at, controller.indexOf("private async currentView"));
    expect(body).toContain("await host.whenReady()");
    // The host throws plain Errors; the caller must see a refusal, not a crash.
    expect(body).toContain("BrowserToolRefused");
  });
});

/**
 * The migration to Obsidian's native Web Viewer removed things. These pin the
 * removals as facts rather than as claims in a comment: a host that quietly
 * grew its own `<webview>` back would be running two browsers, and a security
 * comment describing hardening we no longer do would be worse than none.
 */
describe("the host owns no webview of its own", () => {
  it("creates no webview element and configures no partition", () => {
    expect(host).not.toContain("createElement");
    expect(host).not.toContain("setAttribute");
    expect(host).not.toContain("WEBVIEW_ATTRS");
    expect(host).not.toContain("BROWSER_PARTITION");
  });

  it("installs no permission or download handlers, since the session is not ours", () => {
    expect(host).not.toContain("setPermissionRequestHandler");
    expect(host).not.toContain("setPermissionCheckHandler");
    expect(host).not.toContain("will-download");
    expect(host).not.toContain('require("electron")');
  });

  it("says out loud that the agent browses in Mario's own logged-in session", () => {
    const posture = host.slice(0, host.indexOf("export const WEBVIEWER_VIEW_TYPE"));
    expect(posture).toMatch(/vault session|persist:vault/i);
    expect(posture).toMatch(/logged in|logins|AS MARIO/i);
    // The gate and the escaping are still ours, and the comment must not drop them.
    expect(posture).toMatch(/http\/https URL gate/i);
  });

  it("keeps the URL gate and the injected-script protocol in the controller", () => {
    expect(controller).toContain("isAllowedUrl(url)");
    expect(controller).toContain("browser-inject");
  });
});

describe("the custom exo-browser leaf is gone, not merely unused", () => {
  it("registers no browser view type", () => {
    expect(registry).not.toContain("BrowserView");
    expect(registry).not.toContain("exo-browser");
  });

  it("leaves no .mva-browser styles behind", () => {
    expect(styles).not.toContain("mva-browser");
  });

  it("has no source referring to the deleted leaf", () => {
    for (const src of [controller, host, view]) {
      expect(src).not.toContain("ui/browser-view");
      expect(src).not.toContain("EXO_BROWSER_VIEW_TYPE");
    }
  });
});
