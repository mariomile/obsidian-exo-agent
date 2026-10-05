/**
 * Custom icon registration. Lives here rather than in `main.ts` so the plugin
 * lifecycle file carries behaviour, not a wall of SVG path data.
 *
 * Icons are Solar (Iconify, CC-BY-4.0), `bold duotone` variant — the same set
 * and style Portal reskins onto core Obsidian's Lucide icons app-wide. Exo
 * vendors its own copies here instead of relying on that reskin, because
 * these ids (`hi-*`) aren't Lucide names Portal's registry can match, and a
 * plugin's own UI shouldn't depend on a sibling plugin being installed to
 * look right. Attribution: Solar icon set, CC-BY-4.0, https://icons8.com/icon/set/solar.
 *
 * `addIcon` wraps whatever it is given in an `<svg viewBox="0 0 100 100">` and
 * that viewBox is NOT configurable — every icon authored on a different grid
 * has to be scaled into it explicitly, which is why the Solar icons below (a
 * 24x24 grid) are wrapped in `<g transform="scale(4.166667)">` (100/24). Drop
 * that wrapper and the glyph renders at a quarter size in the corner.
 */
import { addIcon } from "obsidian";
import { EXO_ICON } from "../view";
import { BOARD_ICON } from "./board-view";
import { CHATS_ICON } from "./chat-list-view";
import { COCKPIT_ICON } from "./cockpit-view";
import { HUB_ICON } from "./hub/hub-view";

/** 100/24 — the Solar icons' 24x24 grid scaled into addIcon's fixed 100x100 viewBox. */
const SOLAR = '<g transform="scale(4.166667)">';

export function registerExoIcons(): void {
  // Exo brand mark: two interlocking chevrons forming an X (matches the
  // product logo, `assets/exo-logo.svg`). Authored on a 1254 grid; the mark's
  // 628-unit bounding box is cropped and scaled onto 3..97 of addIcon's 100x100
  // viewBox. Exo's own mark, not a library glyph, so it stays outside the Solar set.
  addIcon(
    EXO_ICON,
    '<g transform="translate(3 3) scale(0.149669) translate(-312.96 -312.5)" fill="currentColor">' +
      '<path d="M312.96 312.5L424.47 312.5L691.96 584.17L691.96 450.28L832.24 312.5L940.7 312.5L940.94 421.77L729.16 632.5L711.46 632.5L626.96 548L559.46 615.5L507.77 615.5L312.96 421.76Z"/>' +
      '<path d="M313.76 831.21L512.46 632.5L546.46 632.5L629.78 715.82L697.8 649.37L757.2 649.58L941.04 832.89L940.83 941.5L827.88 941.5L561.96 677.51L561.96 804.07L420.61 941.5L313.43 941.5Z"/>' +
      "</g>",
  );

  // Orchestration board — Solar "structure" (bold duotone): four connected nodes.
  addIcon(
    BOARD_ICON,
    SOLAR +
      '<path fill="currentColor" d="M8 5a3 3 0 1 1-6 0a3 3 0 0 1 6 0m14 0a3 3 0 1 1-6 0a3 3 0 0 1 6 0M8 19a3 3 0 1 1-6 0a3 3 0 0 1 6 0m14 0a3 3 0 1 1-6 0a3 3 0 0 1 6 0"/>' +
      '<path fill="currentColor" d="M16.093 4.256A1 1 0 0 0 16 4.25H8a1 1 0 0 0-.093.006a3 3 0 0 1 0 1.488q.045.006.093.006h8a1 1 0 0 0 .093-.006a3 3 0 0 1 0-1.488M19 8q.386 0 .744-.093q.006.045.006.093v8a1 1 0 0 1-.006.093a3 3 0 0 0-1.488 0A1 1 0 0 1 18.25 16V8q0-.048.006-.093q.358.091.744.093m-2.907 10.256A1 1 0 0 0 16 18.25H8a1 1 0 0 0-.093.006a3 3 0 0 1 0 1.488q.045.006.093.006h8a1 1 0 0 0 .093-.006a3 3 0 0 1 0-1.488M5 8q-.386 0-.744-.093A1 1 0 0 0 4.25 8v8q0 .048.006.093a3 3 0 0 1 1.488 0A1 1 0 0 0 5.75 16V8a1 1 0 0 0-.006-.093Q5.386 7.998 5 8" opacity=".5"/>' +
      "</g>",
  );

  // Connections marketplace — Solar "puzzle" (bold duotone). Same glyph
  // Portal reskins onto core Obsidian's "puzzle" Lucide icon.
  addIcon(
    HUB_ICON,
    SOLAR +
      '<path fill="currentColor" fill-rule="evenodd" d="M17.5 2.75a.75.75 0 0 1 .75.75v2.25h2.25a.75.75 0 0 1 0 1.5h-2.25V9.5a.75.75 0 0 1-1.5 0V7.25H14.5a.75.75 0 0 1 0-1.5h2.25V3.5a.75.75 0 0 1 .75-.75" clip-rule="evenodd"/>' +
      '<path fill="currentColor" d="M2 6.5c0-2.121 0-3.182.659-3.841S4.379 2 6.5 2s3.182 0 3.841.659S11 4.379 11 6.5s0 3.182-.659 3.841S8.621 11 6.5 11s-3.182 0-3.841-.659S2 8.621 2 6.5m11 11c0-2.121 0-3.182.659-3.841S15.379 13 17.5 13s3.182 0 3.841.659S22 15.379 22 17.5s0 3.182-.659 3.841S19.621 22 17.5 22s-3.182 0-3.841-.659S13 19.621 13 17.5"/>' +
      '<path fill="currentColor" d="M2 17.5c0-2.121 0-3.182.659-3.841S4.379 13 6.5 13s3.182 0 3.841.659S11 15.379 11 17.5s0 3.182-.659 3.841S8.621 22 6.5 22s-3.182 0-3.841-.659S2 19.621 2 17.5" opacity=".5"/>' +
      "</g>",
  );

  // Cockpit — Solar "speedometer" (bold duotone, middle needle position).
  addIcon(
    COCKPIT_ICON,
    SOLAR +
      '<path fill="currentColor" d="M9.02 13.015a3.006 3.006 0 0 0 3.008 3.004a3.006 3.006 0 0 0 3.008-3.004c0-.631-.435-1.507-.974-2.35c-.807-1.26-1.21-1.89-2.034-1.89s-1.227.63-2.034 1.89c-.54.844-.974 1.719-.974 2.35"/>' +
      '<path fill="currentColor" d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2s10 4.477 10 10" opacity=".5"/>' +
      '<path fill="currentColor" d="M4.42 5.476q.49-.566 1.057-1.055l.053.048l1.5 1.5A.75.75 0 0 1 5.97 7.03l-1.5-1.5zM2.028 12.75a10 10 0 0 1 0-1.5H4a.75.75 0 0 1 0 1.5zm3.448 6.83a10 10 0 0 1-1.055-1.056l.049-.055l1.5-1.5a.75.75 0 0 1 1.06 1.061l-1.5 1.5zm14.104-1.056q-.49.566-1.056 1.055l-.054-.049l-1.5-1.5a.75.75 0 1 1 1.06-1.06l1.5 1.5zm2.392-7.274a10 10 0 0 1 0 1.5H20a.75.75 0 0 1 0-1.5zm-3.448-6.83q.566.49 1.055 1.056l-.049.054l-1.5 1.5a.75.75 0 1 1-1.06-1.06l1.5-1.5zM12.75 2.028V4a.75.75 0 0 1-1.5 0V2.028a10 10 0 0 1 1.5 0"/>' +
      "</g>",
  );

  // Chats — Solar "chat square" (bold duotone). Same glyph Portal reskins
  // onto core Obsidian's "message-square" Lucide icon.
  addIcon(
    CHATS_ICON,
    SOLAR +
      '<path fill="currentColor" d="M21.975 13.814A10.95 10.95 0 0 1 17 15.001C10.925 15 6 10.076 6 4q.001-.945.154-1.847c-.715.106-1.277.284-1.766.584a5 5 0 0 0-1.651 1.65C2 5.591 2 7.228 2 10.501v1c0 2.33 0 3.495.38 4.413a5 5 0 0 0 2.707 2.706c.66.274 1.447.35 2.703.372c.85.015 1.275.022 1.613.219c.337.196.548.551.968 1.262l.542.916c.483.816 1.69.816 2.174 0l.542-.916c.42-.71.63-1.066.968-1.262c.338-.197.763-.204 1.613-.219c1.256-.021 2.043-.098 2.703-.372a5 5 0 0 0 2.706-2.706c.227-.547.319-1.182.356-2.1"/>' +
      '<path fill="currentColor" fill-rule="evenodd" d="m13.087 21.389l.542-.916c.42-.71.63-1.066.968-1.262c.338-.197.763-.204 1.613-.219c1.256-.021 2.043-.098 2.703-.372a5 5 0 0 0 2.706-2.706c.227-.547.319-1.182.356-2.1A10.95 10.95 0 0 1 17 15.001C10.925 15 6 10.076 6 4q.001-.945.154-1.847c-.715.106-1.277.284-1.766.584a5 5 0 0 0-1.651 1.65C2 5.591 2 7.228 2 10.501v1c0 2.33 0 3.495.38 4.413a5 5 0 0 0 2.707 2.706c.66.274 1.447.35 2.703.372c.85.015 1.275.022 1.613.219c.337.196.548.551.968 1.262l.542.916c.483.816 1.69.816 2.174 0" clip-rule="evenodd"/>' +
      '<path fill="currentColor" d="M13.5 2h-3c-1.94 0-3.305 0-4.346.153Q6.001 3.055 6 4c0 6.075 4.925 11 11 11c1.79 0 3.48-.428 4.975-1.187C22 13.192 22 12.441 22 11.5v-1c0-3.273 0-4.91-.737-6.112a5 5 0 0 0-1.65-1.651C18.41 2 16.773 2 13.5 2" opacity=".5"/>' +
      "</g>",
  );
}
