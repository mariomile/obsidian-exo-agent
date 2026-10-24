import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * mv-kit style contract (obsidian-cosmos-theme/docs/mv-kit.md).
 *
 * Ported from obsidian-sonar's src/style-contract.test.ts — same four
 * assertions, same scan regexes, same names. Encodes only the state landed by
 * the 2026-07 mv-kit audit wave for Exo — not aspirational rules the audit
 * didn't actually fix. See the audit note at docs/2026-07-mv-kit-audit.md for
 * the full per-value verdict; every waiver below cites its row there.
 */

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** Strip comments so `/* 80ms *\/`-style prose in doc comments doesn't
 * trip the raw-value scan below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('mv-kit style contract', () => {
  // Regression guard for a real outage (2026-07-24): a comment written as
  // `--cosmos-*` immediately followed by a slash terminates the comment early.
  // Everything after it parses as garbage and the browser DROPS the enclosing
  // rule — which silently cost `.sonar-modal` its `width: 880px`, collapsing
  // the modal to Obsidian's 560px default. Invisible to eslint/tsc/vitest and
  // to the raw-value scan below, so it gets its own assertion.
  it('no CSS comment terminates early (token glob followed by a slash)', () => {
    const offenders = css
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /--[\w-]*\*\//.test(line));

    expect(offenders).toEqual([]);
  });

  it('stripping comments leaves no orphaned prose (structural parse check)', () => {
    // If a comment closed early, its remaining lines survive the strip as
    // stray ` * ...` prose sitting in declaration position.
    const orphans = stripComments(css)
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /^\*\s|^\*$/.test(line));

    expect(orphans).toEqual([]);
  });

  it('raw ms/hex/cubic-bezier values appear only as var() fallbacks', () => {
    const code = stripComments(css);
    const lines = code.split('\n');

    // A raw ms/hex/cubic-bezier is allowed ONLY when it sits inside a
    // `var(--cosmos-*, <fallback>)` or `var(--mv-*, <fallback>)` expression —
    // i.e. the line contains `var(--cosmos-` or `var(--mv-` before the raw
    // value. This is a line-level heuristic (matches the audit procedure in
    // mv-kit.md §"Audit procedure": grep for raw values outside a var()
    // fallback), not a full CSS parse.
    const rawMsPattern = /\b\d+ms\b/g;
    const rawHexPattern = /#[0-9a-fA-F]{3,8}\b/g;
    const rawCubicBezierPattern = /cubic-bezier\([^)]*\)/g;

    // ---- Sanctioned raw values -------------------------------------------
    // The scan regexes above are Sonar's, unmodified. Exo, unlike Sonar, still
    // carries raw values the 2026-07 audit examined one by one and knowingly
    // kept. Rather than loosen the scan, each survivor is enumerated here by
    // EXACT trimmed line content plus the EXACT matched value, with its
    // motivation and the audit verdict that sanctions it. A new raw value
    // anywhere else — or a change to one of these lines — fails the test.
    //
    // Source line numbers are given as `styles.css:N`; the numbers the failure
    // message prints are lower, because the scan runs on comment-stripped CSS.
    const SANCTIONED_RAW_VALUES: ReadonlyArray<{ line: string; value: string; why: string }> = [
      // styles.css:14 (`--mva-ease-out`) USED to be sanctioned here as a raw
      // bezier. The 2026-07 §6 "dinamica" wave landed the byte-identical bridge
      // `--mva-ease-out: var(--mv-lift, cubic-bezier(0.22, 1, 0.36, 1))`, so the
      // bezier now sits in a var() fallback and clears the raw scan on its own
      // (`hasVarFallback`). No sanction entry needed; a dedicated §6 assertion
      // below pins the bridge so it cannot regress to a bare literal.
      {
        // styles.css:2928 — context-ring donut fill. Carries an inline
        // directive at 2925-2927: "Sole sanctioned motion override … Do not
        // tokenize this line." Audit verdict: "waived — a documented,
        // deliberate pre-existing exception". Reduced motion still reaches it
        // twice (blanket at 3660 + dedicated `transition: none` at 2951), so
        // only the tokenization MUST is traded, never the accessibility one.
        line: 'transition: background 220ms cubic-bezier(0.16, 1, 0.3, 1);',
        value: '220ms',
        why: 'context-ring donut fill; audit: waived, inline "do not tokenize this line" directive',
      },
      {
        // styles.css:2928, same declaration, bezier half of the same waiver.
        line: 'transition: background 220ms cubic-bezier(0.16, 1, 0.3, 1);',
        value: 'cubic-bezier(0.16, 1, 0.3, 1)',
        why: 'context-ring donut fill; audit: waived, same line as the 220ms above',
      },
      {
        // styles.css:3669 — inside the blanket `prefers-reduced-motion` block.
        // `0.001ms` IS the reduced-motion implementation: the standard
        // near-zero-not-zero idiom (a true 0 suppresses `animationend`).
        // Audit verdict: "pass — tokenizing it would be circular."
        // (The scan matches `001ms` because `\b\d+ms\b` starts after the dot.)
        line: 'animation-duration: 0.001ms;',
        value: '001ms',
        why: 'prefers-reduced-motion near-zero idiom; audit: pass, tokenizing would be circular',
      },
      {
        // styles.css:3671 — same block, transitions instead of animations.
        // Audit verdict: "pass — same, for transitions."
        line: 'transition-duration: 0.001ms;',
        value: '001ms',
        why: 'prefers-reduced-motion near-zero idiom (transitions); audit: pass',
      },
      {
        // styles.css:3776 — `.mva-artifact-frame iframe { background: #fff; }`.
        // Paper background for a sandboxed HTML artifact preview: the iframe
        // renders third-party HTML authored against a white page, so theming
        // it to --background-primary puts a dark surface under black body text
        // and makes artifacts unreadable. Audit verdict: "waived — it is not a
        // Cosmos surface and no kit token covers 'document paper'. Deliberate,
        // not leakage." (docs/2026-07-mv-kit-audit.md, hex group 11.)
        line: 'background: #fff;',
        value: '#fff',
        why: 'artifact-iframe paper background; audit: waived, no kit token covers "document paper"',
      },
    ];

    const isSanctioned = (line: string, value: string): boolean =>
      SANCTIONED_RAW_VALUES.some((entry) => entry.line === line && entry.value === value);

    const violations: string[] = [];

    lines.forEach((line, idx) => {
      // A raw value is allowed when it sits as the fallback inside ANY
      // var(--token, <fallback>) expression (native Obsidian tokens like
      // --color-base-00 included) — the contract's requirement is "never a
      // bare value", not "only --cosmos-*/--mv-* tokens may have fallbacks".
      const hasVarFallback = /var\(\s*--[\w-]+\s*,/.test(line);

      for (const pattern of [rawMsPattern, rawHexPattern, rawCubicBezierPattern]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (!hasVarFallback && !isSanctioned(line.trim(), match[0])) {
            violations.push(`line ${idx + 1}: "${match[0]}" in "${line.trim()}"`);
          }
        }
      }
    });

    expect(violations).toEqual([]);
  });

  it('has no !important declarations', () => {
    const importantCount = (css.match(/!important;/g) ?? []).length;
    // Zero since the 2026-09 Obsidian plugin review flagged every remaining
    // one. The five audit survivors (reduced-motion blanket, keyboard focus
    // ring) now win on specificity: `:is(<selector>, #mva-never)` lends id-level
    // weight without matching anything. Keep it at zero: reach for that pattern,
    // not `!important`.
    expect(importantCount).toBe(0);
  });

  // ---- §6 "Elevation & motion depth" (2026-07 dinamica wave) --------------
  // Only concrete rules that actually emerged from the §6 audit
  // (docs/2026-07-mv-kit-audit.md, section "§6 — wave 2026-07 dinamica").
  // No speculative assertions: each of these pins a fact the audit verified or
  // a fix it landed, and each would catch a real regression.

  it('§6 physical-lift easing routes through --mv-lift (not a bare bezier)', () => {
    // §6 hover/reveal MUST: "physical lifts (transform) ease with --mv-lift".
    // The wave bridged Exo's own lift-easing token to the kit token, keeping
    // the canonical bezier as the literal fallback (byte-identical rendering).
    // Regressing it to a bare `cubic-bezier(...)` would silently un-bridge the
    // file's entrance/reveal easing from the kit under Cosmos.
    const decl = css
      .split('\n')
      .find((line) => /--mva-ease-out\s*:/.test(line))
      ?.trim();

    expect(decl).toBe('--mva-ease-out: var(--mv-lift, cubic-bezier(0.22, 1, 0.36, 1));');
  });

  // ---- §7 "Reading rhythm" (2026-07 lettura wave) -------------------------
  // Only the prose surfaces the §7 audit actually re-tokenized
  // (docs/2026-07-mv-kit-audit.md, section "§7 — wave 2026-07 lettura").
  // Chrome line-heights (chips, badges, cards, inputs) and the documented
  // deviations (clamped previews, code/diff blocks, the artifact thumbnail)
  // are deliberately NOT asserted here — they stay on the UI scale by verdict,
  // and pinning them would freeze a taste call this wave was not allowed to
  // make.

  it('§7 prose surfaces read their leading from the reading tokens', () => {
    // §7 MUST: "a plugin that renders prose (note preview, chat message, card
    // excerpt, search snippet) inherits the reading tokens — the
    // `--line-height-` family, `--p-spacing`, `--font-text-size` — rather than
    // hardcoding its own line-height". These four rules were the hardcoded
    // ones; each now consumes the token with its pre-wave literal as fallback,
    // so a Cosmos-less install renders byte-identically and a Cosmos install
    // inherits the desktop/phone 1.6-vs-1.55 split instead of flattening it.
    const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2],
    }));

    const PROSE_LEADING: ReadonlyArray<readonly [selector: string, decl: string]> = [
      // Chat message body (user bubble + rendered-markdown assistant answer).
      ['.mva-bubble', 'line-height: var(--line-height-normal, 1.55);'],
      // Headings inside that rendered markdown: Obsidian's tight leading, whose
      // native default IS 1.3 — the pre-wave literal, so nothing moves.
      [
        '.mva-bubble h1, .mva-bubble h2, .mva-bubble h3, .mva-bubble h4, .mva-bubble h5, .mva-bubble h6',
        'line-height: var(--line-height-tight, 1.3);',
      ],
      // Inline-edit / note-diff preview: a note preview, and already the one
      // surface consuming `--font-text-size` before this wave.
      ['.mva-ie-preview', 'line-height: var(--line-height-normal, 1.55);'],
      // Live streamed rewrite text in the inline-AI chip: model prose about to
      // land in the note.
      ['.mva-inai-streamtext', 'line-height: var(--line-height-normal, 1.5);'],
    ];

    const offenders: string[] = [];
    for (const [selector, decl] of PROSE_LEADING) {
      const declared = rules
        .filter((r) => r.selector === selector)
        .flatMap((r) => r.body.match(/line-height:[^;]*;/g) ?? [])
        .map((d) => d.trim());
      if (declared.length !== 1 || declared[0] !== decl) {
        offenders.push(`${selector} → ${JSON.stringify(declared)} (expected ["${decl}"])`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('§6 drag/motion never animates layout properties (left/top/margin)', () => {
    // §6 drag-polish MUST: "drag positioning uses transform, never
    // left/top/margin". Native HTML5 drag lets the
    // browser composite the ghost, so no transition drives layout geometry,
    // but a future transition that animates left/top/margin would both thrash
    // layout and break the drag MUST. This scans transition SHORTHANDS for a
    // layout-triggering property. `.mva-inputwrap.is-anim .mva-input` (height)
    // and `.mva-outline-tick` (width) are pre-existing waivers tracked in the
    // audit's carried-forward list; they animate height/width, not the
    // left/top/margin the §6 drag rule names, so they are not in scope here.
    const code = stripComments(css);
    const offenders = code
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /transition:[^;]*\b(left|top|margin)\b/.test(line));

    expect(offenders).toEqual([]);
  });
});

// =========================================================================
// The Cosmos Bridge: one token seam instead of scattered fallbacks
// (docs/plans/2026-08-11-chat-cosmos-alignment-plan.md, Phases 1-3)
// =========================================================================

const SEAM_START = '/* ===== COSMOS BRIDGE START ===== */';
const SEAM_END = '/* ===== COSMOS BRIDGE END ===== */';

/** The seam block: the ONE place in the stylesheet allowed to name a Cosmos
 * token. Everything else consumes the `--mva-` aliases it publishes. */
function seam(): string {
  const from = css.indexOf(SEAM_START);
  const to = css.indexOf(SEAM_END);
  expect(from, 'seam start sentinel missing from styles.css').toBeGreaterThan(-1);
  expect(to, 'seam end sentinel missing from styles.css').toBeGreaterThan(from);
  return css.slice(from, to + SEAM_END.length);
}

/** Everything outside the seam: the component layer. */
function outsideSeam(): string {
  const from = css.indexOf(SEAM_START);
  const to = css.indexOf(SEAM_END);
  return css.slice(0, from) + css.slice(to + SEAM_END.length);
}

describe('Cosmos bridge: Phase 1 token seam', () => {
  it('the seam sits near the top of the stylesheet', () => {
    // "Near the top": before any component rule, so a reader meets the token
    // vocabulary before the first `.mva-` selector that spends it. The
    // @settings block and the file header comment are the only things above it.
    const seamStart = css.indexOf(SEAM_START);
    const firstComponentRule = css.search(/^\.mva-/m);
    expect(seamStart).toBeGreaterThan(-1);
    expect(seamStart).toBeLessThan(firstComponentRule);
  });

  it('no rule outside the seam reads a Cosmos token directly', () => {
    // The whole point of the seam: `--mv-` / `--cosmos-` names resolve ONCE.
    // A component that reaches for one directly re-opens the 39-fallback
    // problem the seam exists to close.
    const offenders = stripComments(outsideSeam())
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /var\(\s*--(?:mv|cosmos)-/.test(line));

    expect(offenders).toEqual([]);
  });

  it('every Cosmos reference inside the seam is a full resolution chain', () => {
    // The chain is `--mv-x` → `--cosmos-x` → Obsidian fallback. A bare
    // `var(--mv-x)` with no fallback silently un-styles the surface on a
    // Cosmos-less install, which is exactly the regression the seam prevents.
    const body = stripComments(seam());
    const offenders: string[] = [];
    for (const m of body.matchAll(/var\(\s*--(?:mv|cosmos)-[\w-]+\s*([,)])/g)) {
      if (m[1] !== ',') offenders.push(m[0]);
    }
    expect(offenders).toEqual([]);
  });

  it('§1 surfaces: the ends alias Cosmos, the middle is built, and every rung is spent', () => {
    const body = stripComments(seam());
    // Only the two ENDS alias the kit: rung 0 is the canvas, rung 3 the theme's
    // own raised surface, and both track the active flavour.
    expect(body).toMatch(/--mva-surface-0\s*:[^;]*var\(\s*--cosmos-surface-0/);
    expect(body).toMatch(/--mva-surface-3\s*:[^;]*var\(\s*--cosmos-surface-3/);
    // The middle rung is BUILT between those ends, never aliased to Cosmos's
    // own 1: there rung 1 is chrome, not elevation, so it equals rung 0 under
    // `realcraft` and sits DARKER than rung 0 under `linear`. Aliasing it would
    // flatten a raised surface under one flavour and recess it under another;
    // mixing between the ends keeps a raise a raise everywhere.
    expect(body).toMatch(/--mva-surface-1\s*:[^;]*color-mix\(in srgb, var\(--mva-surface-0\)[^;]*var\(--mva-surface-3\)/);
    expect(body).not.toMatch(/--mva-surface-1\s*:[^;]*var\(\s*--cosmos-surface-/);

    // And nothing is published that nothing stands on. This used to read "a
    // 4-step ladder" and REQUIRED a rung 2 that had zero consumers anywhere in
    // the file: the assertion was the only thing holding the dead declaration
    // up. A ladder is its steps, so the test now asks for a consumer per rung
    // instead of a count.
    const outside = stripComments(outsideSeam());
    for (const m of body.matchAll(/--mva-surface-(\d)\s*:/g)) {
      expect(outside, `--mva-surface-${m[1]} is declared and never spent`).toMatch(
        new RegExp(`var\\(--mva-surface-${m[1]}\\)`),
      );
    }
  });

  it('§1 elevation: the rest/lift pair aliases the kit card shadows', () => {
    const body = stripComments(seam());
    expect(body).toMatch(/--mva-shadow-rest\s*:\s*var\(\s*--mv-card-rest\s*,/);
    expect(body).toMatch(/--mva-shadow-lift\s*:\s*var\(\s*--mv-card-lift\s*,/);
  });

  it('§1 radii are concentric by construction, not three loose numbers', () => {
    // Inner = outer − inset, as a calc(). Three independent literals is the
    // failure mode: they drift apart the first time one of them is nudged.
    const body = stripComments(seam());
    expect(body).toMatch(/--mva-r2\s*:[^;]*calc\([^;]*var\(--mva-r3\)[^;]*var\(--mva-r-inset\)/);
    expect(body).toMatch(/--mva-r1\s*:[^;]*calc\([^;]*var\(--mva-r2\)[^;]*var\(--mva-r-inset/);
    // …and only r3 carries a number of its own.
    expect(body).not.toMatch(/--mva-r1\s*:\s*\d/);
    expect(body).not.toMatch(/--mva-r2\s*:\s*\d/);
  });

  it('§1 one heartbeat: no rule declares its own pulse duration', () => {
    // Nine unrelated rhythms (1.1s / 1.2s / 1.4s / 1.6s / 2s / 2.6s / 4.5s / 1s)
    // read as eight different products breathing at once. One token, one pulse.
    const body = stripComments(seam());
    expect(body).toMatch(/--mva-heartbeat\s*:\s*[\d.]+m?s\s*;/);

    // Every animation on a pulse-family keyframe must spend the token.
    const PULSE_KEYFRAMES = /mva-(pulse|blink|breathe|working-pulse|ll-pulse|chats-dot-pulse|chats-breathe)\b/;
    const offenders = stripComments(css)
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /animation:/.test(line) && PULSE_KEYFRAMES.test(line))
      .filter(({ line }) => !line.includes('var(--mva-heartbeat)'));

    expect(offenders).toEqual([]);
  });

  it('§1 the seam declares each alias exactly once', () => {
    // A token defined twice is a token with two meanings. The seam is a
    // vocabulary, and a vocabulary has one entry per word.
    const body = stripComments(seam());
    const counts = new Map<string, number>();
    for (const m of body.matchAll(/(--mva-[\w-]+)\s*:/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dups).toEqual([]);
  });
});

describe('Cosmos bridge: Phase 2 type registers', () => {
  it('§2 the three registers exist as tokens with size, weight and tracking', () => {
    const body = stripComments(seam());
    for (const register of ['eyebrow', 'title', 'body']) {
      for (const axis of ['size', 'weight', 'track']) {
        expect(
          body,
          `--mva-type-${register}-${axis} missing from the seam`,
        ).toMatch(new RegExp(`--mva-type-${register}-${axis}\\s*:`));
      }
    }
  });

  it('§2 one class per register, and each spends its own tokens', () => {
    const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2],
    }));
    for (const register of ['eyebrow', 'title', 'body']) {
      const rule = rules.find((r) => r.selector === `.mva-type-${register}`);
      expect(rule, `.mva-type-${register} class missing`).toBeTruthy();
      expect(rule?.body).toMatch(new RegExp(`font-size:\\s*var\\(--mva-type-${register}-size\\)`));
      expect(rule?.body).toMatch(new RegExp(`font-weight:\\s*var\\(--mva-type-${register}-weight\\)`));
      expect(rule?.body).toMatch(new RegExp(`letter-spacing:\\s*var\\(--mva-type-${register}-track\\)`));
    }
  });

  it('§2 the eyebrow register never lands on a form-field label (design.md §3)', () => {
    // design.md §3 + §7 anti-patterns: UPPERCASE eyebrows on form fields is the
    // single most-repeated register mistake in the suite. Form labels are
    // register C. Scanned in the TS that builds the DOM, not in the CSS.
    const FORM_LABEL_CLASSES = ['mva-pv-label', 'mva-auto-label'];
    const files = ['./ui/chat-list-view.ts', './ui/composer.ts', './ui/steps.ts', './view.ts'];
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), 'utf8');
      // Statements, not lines: a builder call chained across four lines is one
      // statement, and reading line by line would let a form label pick up the
      // eyebrow simply by wrapping.
      for (const statement of text.split(';')) {
        if (!statement.includes('mva-type-eyebrow')) continue;
        if (FORM_LABEL_CLASSES.some((c) => statement.includes(c)))
          offenders.push(`${f}: ${statement.replace(/\s+/g, ' ').trim()}`);
      }
      // …and the second shape: the element is built as a form label on one
      // statement and given the eyebrow on another, through the variable that
      // holds it. Track the names, then watch what gets added to them.
      const labelVars = new Set<string>();
      for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]{0,400}?);/g)) {
        if (FORM_LABEL_CLASSES.some((c) => m[2].includes(c))) labelVars.add(m[1]);
      }
      for (const m of text.matchAll(
        /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:addClass|classList\s*\.\s*add|addClasses)\s*\(([^)]*)\)/g,
      )) {
        if (labelVars.has(m[1]) && m[2].includes('mva-type-eyebrow'))
          offenders.push(`${f}: ${m[0].replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Cosmos bridge: Phase 3 the running state is the identity moment', () => {
  it('§3 the glow is a color-mix on the accent, never a literal, never a gradient', () => {
    const body = stripComments(seam());
    const decl = body.match(/--mva-glow\s*:[^;]+;/)?.[0];
    expect(decl, '--mva-glow missing from the seam').toBeTruthy();
    expect(decl).toMatch(/color-mix\(in srgb, var\(--interactive-accent\)/);
    expect(decl).not.toMatch(/gradient/);
    expect(decl).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('§3 only the working row and the caret carry the glow', () => {
    const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }))
      .filter((r) => r.body.includes('var(--mva-glow)'));
    const ALLOWED = new Set(['.mva-working-star', '.mva-caret', '50%']);
    const offenders = rules.map((r) => r.selector).filter((s) => !ALLOWED.has(s));
    expect(offenders).toEqual([]);
  });

  it('§3 no second glow: blurs, drop-shadows and radial auras belong to the run', () => {
    // Companion to the assertion above, which can only see rules that already
    // spend `--mva-glow` and is therefore blind to a glow built straight from
    // the accent. That blind spot was real: the idle welcome star wore a
    // blurred radial aura of `--mva-brand`, on the empty state, where nothing
    // is running. This scan reads the effect, not the token name.
    // A ring is not a glow: `0 0 0 2px accent` has a blur radius of 0 and is a
    // border drawn with a shadow. Only a non-zero blur radius is light.
    const IDENTITY = /var\(\s*--(?:mva-glow|mva-brand|mva-accent|interactive-accent)\b/;
    const ALLOWED = new Set(['.mva-working-star', '.mva-caret']);
    const offenders: string[] = [];
    for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].replace(/\s+/g, ' ').trim();
      if ([...ALLOWED].some((s) => selector === s || selector.endsWith(` ${s}`))) continue;
      for (const decl of rule[2].split(';')) {
        const prop = decl.split(':')[0].trim();
        const value = decl.slice(decl.indexOf(':') + 1).trim();
        if (!decl.includes(':') || !IDENTITY.test(value)) continue;
        if (/radial-gradient\(/.test(value)) {
          offenders.push(`${selector} { ${prop}: radial aura }`);
        } else if (/^(?:-webkit-)?(?:backdrop-)?filter$/.test(prop) && /\b(?:blur|drop-shadow)\(/.test(value)) {
          offenders.push(`${selector} { ${prop} }`);
        } else if (prop === 'box-shadow') {
          const blurred = [...value.matchAll(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?/g)].some(
            (m) => Number(m[3]) > 0,
          );
          if (blurred) offenders.push(`${selector} { box-shadow (blurred) }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('§3 the glow beats on the Phase 1 heartbeat and dies under reduced motion', () => {
    const code = stripComments(css);
    // The two glowing surfaces animate on the shared token, not their own timing.
    expect(code).toMatch(/\.mva-working-star\s*\{[^}]*animation:[^;]*var\(--mva-heartbeat\)/);
    expect(code).toMatch(/\.mva-caret\s*\{[^}]*animation:[^;]*var\(--mva-heartbeat\)/);
    // …and the reduced-motion block zeroes the glow itself, not just the motion:
    // a frozen glow is still a glow.
    const reduced = code.slice(code.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.mva-caret\s*\{[^}]*box-shadow:\s*none/);
    expect(reduced).toMatch(/\.mva-working-star\s*\{[^}]*filter:\s*none/);
  });

  it('§3 --mva-accent exists and is spent only at decision points', () => {
    const body = stripComments(seam());
    expect(body).toMatch(/--mva-accent\s*:/);
    const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }))
      .filter((r) => r.body.includes('var(--mva-accent)'));
    // Primary action, active/focus ring, pending approval. Nothing decorative.
    const ALLOWED = new Set([
      '.mva-btn-primary',
      '.mva-root :focus-visible',
      // "Pending approval" is the permission card BEFORE it is answered: the
      // renderer stamps `is-resolved` on it the moment a verdict lands, so the
      // ring lives exactly as long as the decision does.
      '.mva-perm:not(.is-resolved)',
    ]);
    const offenders = rules.map((r) => r.selector).filter((s) => !ALLOWED.has(s));
    expect(offenders).toEqual([]);
    expect(rules.length).toBeGreaterThanOrEqual(3);
  });

  it('§3 provider brand colours never appear in the stylesheet as brand fills', () => {
    // The two brand accents are identity DOTS, applied from the provider
    // adapters (`brandColor`) onto a dot element: never a surface fill, and
    // never a literal in the stylesheet.
    // Both hexes are read from the adapters rather than typed here, because a
    // test that pins only the colour it knows is clean is not a test. Codex's
    // green was in this file 14 times as the `var(--color-green, #19c37d)`
    // semantic fallback — the same bytes doing a different job, which reads as
    // "the provider's green means success" to anyone grepping. It is now
    // `#3fb950`, and the collision cannot come back unnoticed. Verdict in
    // docs/2026-07-mv-kit-audit.md.
    const brands = ['./providers/claude.ts', './providers/codex.ts'].map((file) => {
      const hex = readFileSync(new URL(file, import.meta.url), 'utf8').match(
        /brandColor:\s*["'](#[0-9a-fA-F]{3,8})["']/,
      )?.[1];
      expect(hex, `brandColor missing from ${file}`).toBeTruthy();
      return hex as string;
    });
    expect(brands).toHaveLength(2);
    const code = stripComments(css);
    for (const hex of brands) {
      expect(code, `${hex} is a provider brand colour and must not be in styles.css`).not.toMatch(
        new RegExp(hex, 'i'),
      );
    }
  });
});
