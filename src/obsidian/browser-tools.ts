/**
 * Agent-browser tools: the eight `browser_*` tool definitions for the shared,
 * visible browser tab (see docs/plans/2026-08-11-scoped-browser-plan.md).
 *
 * This module is deliberately Obsidian-free at runtime: it depends only on the
 * `BrowserBridge` interface, which the plugin's browser controller implements
 * per conversation (`browserBridgeFor`). That keeps the tool surface testable
 * with a fake bridge and mirrors the askBridge/rethinkBridge pattern:
 * tools.ts must never import view or controller code.
 */
import * as z from "zod";
import { claudeSdk } from "../providers/sdk-loader";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, err } from "./tool-kit";
import {
  capPageText,
  formatSnapshot,
  formatStatus,
  type BrowserPageStatus,
  type PageElement,
} from "../core/browser-page";
import type { ElementTarget } from "../core/browser-inject";
import type { AnyTool } from "./sdk-tool";

/** Bridge-level status: page state plus who holds the lease. */
export interface BrowserStatus extends BrowserPageStatus {
  ownerConvoId: string | null;
}

/** Expected-traffic refusal (lease held elsewhere, feature unsupported here,
 *  URL rejected). Tools surface the message as a normal result so the model
 *  reads an answer instead of retrying, same contract as ChildTaskRefused. */
export class BrowserToolRefused extends Error {}

/** What the plugin-side controller implements, curried per conversation. */
export interface BrowserBridge {
  open(url?: string): Promise<BrowserStatus>;
  navigate(url: string): Promise<BrowserStatus>;
  snapshot(): Promise<{ status: BrowserStatus; elements: PageElement[] }>;
  readPage(): Promise<{ status: BrowserStatus; text: string; total: number }>;
  screenshot(): Promise<{ status: BrowserStatus; pngB64: string }>;
  click(target: ElementTarget): Promise<BrowserStatus>;
  type(
    target: ElementTarget,
    text: string,
    opts: { clear?: boolean; submit?: boolean },
  ): Promise<BrowserStatus>;
  scroll(op: { to?: "top" | "bottom"; pages?: number }): Promise<BrowserStatus>;
}

/** Route bridge failures: refusals read as answers, crashes read as errors.
 *  Typed on CallToolResult rather than the text-only kit Result, because the
 *  screenshot tool legitimately returns an image block: widening happens here,
 *  never in the shared tool-kit. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BrowserToolRefused) return ok(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Exactly one of ref/selector, as an ElementTarget, or an error string. */
function targetOf(args: { ref?: string; selector?: string }): ElementTarget | string {
  if (!!args.ref === !!args.selector) {
    return "Pass exactly one of `ref` (from browser_snapshot) or `selector` (CSS).";
  }
  return args.ref ? { ref: args.ref } : { selector: args.selector! };
}

export function buildBrowserTools(bridge: BrowserBridge): AnyTool[] {
  const { tool } = claudeSdk();
  const browserOpen = tool(
    "browser_open",
    "Open the shared agent-browser tab in the workspace (creating it if needed) and take control of it for this conversation. Use it to research a source IN FRONT of Mario; he sees the same page you read, which beats a blind web fetch whenever the source matters. Optionally pass a url to navigate immediately. If another conversation was driving the tab, this takes over (say so).",
    { url: z.string().optional().describe("http(s) URL to open right away.") },
    async (args) =>
      run(async () => {
        const status = await bridge.open(args.url);
        return ok(formatStatus(status));
      }),
  );

  const browserNavigate = tool(
    "browser_navigate",
    "Navigate the shared browser tab to a URL (http/https only) and wait for the page to settle. Requires having called browser_open in this conversation first.",
    { url: z.string() },
    async (args) =>
      run(async () => {
        const status = await bridge.navigate(args.url);
        return ok(formatStatus(status));
      }),
  );

  const browserSnapshot = tool(
    "browser_snapshot",
    "Inspect the current page before interacting: returns URL, title, scroll position, and an outline of visible interactive elements (links, buttons, inputs, headings), each with a ref you can pass to browser_click / browser_type. Refs go stale on navigation: snapshot again after the page changes.",
    {},
    async () =>
      run(async () => {
        const { status, elements } = await bridge.snapshot();
        return ok(formatSnapshot(status, elements));
      }),
  );

  const browserReadPage = tool(
    "browser_read_page",
    "Read the current page's visible text (main content when the page marks one, else the whole body), capped for length. This is the workhorse for research: navigate, then read.",
    {},
    async () =>
      run(async () => {
        const { status, text, total } = await bridge.readPage();
        return ok(`${formatStatus(status)}\n\n---\n${capPageText(text, total)}`);
      }),
  );

  const browserScreenshot = tool(
    "browser_screenshot",
    "Capture the visible page as an image, so you can see the page exactly as Mario does (layout, figures, charts). Use it when the visual matters or the text extraction looks wrong.",
    {},
    async () =>
      run(async () => {
        const { status, pngB64 } = await bridge.screenshot();
        return {
          content: [
            { type: "image" as const, data: pngB64, mimeType: "image/png" },
            { type: "text" as const, text: formatStatus(status) },
          ],
        };
      }),
  );

  const browserClick = tool(
    "browser_click",
    "Click one element in the shared browser tab, by ref (preferred, from browser_snapshot) or CSS selector. Requires the browser lease (browser_open).",
    { ref: z.string().optional(), selector: z.string().optional() },
    async (args) =>
      run(async () => {
        const target = targetOf(args);
        if (typeof target === "string") return err(target);
        const status = await bridge.click(target);
        return ok(formatStatus(status));
      }),
  );

  const browserType = tool(
    "browser_type",
    "Type text into one input/textarea/contenteditable in the shared browser tab, by ref or CSS selector. `clear` replaces existing content; `submit` presses Enter and submits the enclosing form (search boxes). Requires the browser lease.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
    },
    async (args) =>
      run(async () => {
        const target = targetOf(args);
        if (typeof target === "string") return err(target);
        const status = await bridge.type(target, args.text, {
          ...(args.clear !== undefined ? { clear: args.clear } : {}),
          ...(args.submit !== undefined ? { submit: args.submit } : {}),
        });
        return ok(formatStatus(status));
      }),
  );

  const browserScroll = tool(
    "browser_scroll",
    "Scroll the shared browser tab: `to` top/bottom, or `pages` viewport-heights down (negative scrolls up; default 1). Requires the browser lease.",
    {
      to: z.enum(["top", "bottom"]).optional(),
      pages: z.number().optional(),
    },
    async (args) =>
      run(async () => {
        const status = await bridge.scroll({
          ...(args.to ? { to: args.to } : {}),
          ...(args.pages !== undefined ? { pages: args.pages } : {}),
        });
        return ok(formatStatus(status));
      }),
  );

  return [
    browserOpen,
    browserNavigate,
    browserSnapshot,
    browserReadPage,
    browserScreenshot,
    browserClick,
    browserType,
    browserScroll,
  ];
}

/** The observing tools: they change nothing Mario sees and write nothing, so
 *  they ride the same auto-allow rail as the read-only vault tools. Everything else raises a
 *  permission card whose input (URL, selector, text) is the evidence trail. */
export const BROWSER_READ_TOOLS = new Set([
  "mcp__obsidian__browser_snapshot",
  "mcp__obsidian__browser_read_page",
  "mcp__obsidian__browser_screenshot",
]);
