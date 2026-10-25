import { describe, it, expect } from "vitest";
import {
  applyAdd,
  applyUpdate,
  checkTarget,
  explicitRulePaths,
  buildDecidePrompt,
  inboxNote,
  stripProvenance,
  harvestCommitMessage,
  harvestBlocklist,
  harvestSlice,
  isHarvestDue,
  matchingLines,
  memoryRulesSection,
  parseCandidates,
  parseDecisions,
  revertCommitMessage,
  worthExtracting,
  HARVEST_IDLE_MS,
  HARVEST_LOOKBACK_MS,
  type HarvestProvenance,
  type TargetEnv,
} from "../src/core/memory-harvest";
import { containsSecret, safeTitle } from "../src/core/text-safety";
import { formatProvenance } from "../src/core/block-patch";
import { formatSupersede } from "../src/core/supersede";
import type { ChatMessage } from "../src/core/recent-chats";
import { exoPaths } from "../src/core/paths";
import { makeExclusion } from "../src/core/vault-exclusions";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const user = (text: string, at?: number): ChatMessage => ({ role: "user", text, ...(at !== undefined ? { at } : {}) });
const asst = (md: string): ChatMessage => ({ role: "assistant", segments: [{ t: "text", md }] });

describe("isHarvestDue", () => {
  const base = { messageCount: 4, harvestedIndex: 2, streaming: false, lastActivityAt: NOW - HARVEST_IDLE_MS };
  it("is due once idle for 10 minutes with unharvested messages", () => {
    expect(isHarvestDue(base, NOW)).toBe(true);
    expect(isHarvestDue({ ...base, lastActivityAt: NOW - HARVEST_IDLE_MS + 1 }, NOW)).toBe(false);
  });
  it("is due immediately when the user leaves it", () => {
    expect(isHarvestDue({ ...base, lastActivityAt: NOW }, NOW, true)).toBe(true);
  });
  it("is never due mid-turn or with nothing new", () => {
    expect(isHarvestDue({ ...base, streaming: true }, NOW, true)).toBe(false);
    expect(isHarvestDue({ ...base, harvestedIndex: 4 }, NOW, true)).toBe(false);
  });
  it("an absent watermark means everything is unharvested", () => {
    expect(isHarvestDue({ ...base, harvestedIndex: undefined }, NOW)).toBe(true);
  });
});

describe("harvestSlice", () => {
  it("starts at the watermark and ends at the message count", () => {
    const msgs = [user("old question here", NOW - 1000), asst("old answer"), user("new question here", NOW - 500), asst("new answer")];
    const { lines, end } = harvestSlice(msgs, 2, NOW);
    expect(end).toBe(4);
    expect(lines.map((l) => l.text)).toEqual(["new question here", "new answer"]);
  });
  it("assistant messages inherit the previous timestamp; anything past the lookback is skipped", () => {
    const stale = NOW - HARVEST_LOOKBACK_MS - 1;
    const msgs = [user("ancient thing", stale), asst("ancient reply"), user("fresh thing", NOW - 10), asst("fresh reply")];
    const { lines } = harvestSlice(msgs, undefined, NOW);
    expect(lines.map((l) => l.text)).toEqual(["fresh thing", "fresh reply"]);
  });
  it("a watermark past the end (rewound chat) yields nothing", () => {
    expect(harvestSlice([user("x y z w", NOW)], 9, NOW).lines).toEqual([]);
  });
});

describe("worthExtracting", () => {
  it("needs real user text, slash commands do not count", () => {
    expect(worthExtracting([{ role: "user", at: NOW, text: "/compact", artifacts: [] }])).toBe(false);
    expect(worthExtracting([{ role: "user", at: NOW, text: "I prefer Italian for strategy notes", artifacts: [] }])).toBe(true);
  });
});

describe("containsSecret", () => {
  it.each([
    "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "password: hunter2hunter2",
    "api_key=abcdef123456",
    "Authorization: Bearer abcdefghijklmnopqrstuv",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "DATABASE_PASSWORD=correcthorse",
    "export GITHUB_TOKEN: abc",
    "stripe sk_live_51Habc",
    "clone https://mario:hunter2@github.com/x/y",
    "la password è Gatto123",
    "password e' gatto",
  ])("flags %s", (text) => {
    expect(containsSecret(text)).toBe(true);
  });
  it("leaves ordinary facts alone", () => {
    expect(containsSecret("Mario prefers short Italian answers for strategy")).toBe(false);
    expect(containsSecret("The token budget is 200k per day")).toBe(false);
  });
});

describe("parseCandidates", () => {
  it("parses typed facts, tolerating fences and prose", () => {
    const raw =
      'Sure:\n```json\n{"facts":[{"kind":"person","statement":"Anna leads design at Acme now","entity":"Anna","evidence":"Anna now leads design"}]}\n```';
    expect(parseCandidates(raw)).toEqual([
      { kind: "person", statement: "Anna leads design at Acme now", entity: "Anna", evidence: "Anna now leads design" },
    ]);
  });
  it("drops unknown kinds, trivial statements and anything carrying a secret", () => {
    const raw = JSON.stringify({
      facts: [
        { kind: "gossip", statement: "Not a real kind at all", evidence: "" },
        { kind: "user", statement: "short", evidence: "" },
        { kind: "user", statement: "The API key is sk-proj-abcdefghijklmnopqrstu", evidence: "" },
        { kind: "user", statement: "Prefers bullets over paragraphs", evidence: "said so" },
      ],
    });
    expect(parseCandidates(raw).map((c) => c.statement)).toEqual(["Prefers bullets over paragraphs"]);
  });
  it("garbage yields no candidates", () => {
    expect(parseCandidates("no json here")).toEqual([]);
    expect(parseCandidates("{broken")).toEqual([]);
  });
});

describe("memoryRulesSection + explicitRulePaths", () => {
  const agents = [
    "# Contract",
    "## Regole",
    "- stuff",
    "## Memoria",
    "Il vault è la memoria.",
    "| fatto | `Knowledge/Identity/mario-mental-model.md` |",
    "| persona | `CRM/People/` |",
    "| inbox | `_system/memory/inbox/AAAA-MM-GG.md` |",
    "| agent | `_system/memory/agents/<slug>.md` |",
    "### Chi scrive",
    "- Exo",
    "## Mappa",
    "- other",
  ].join("\n");
  it("takes the memory section, subsections included, up to the next peer heading", () => {
    const rules = memoryRulesSection(agents);
    expect(rules.startsWith("## Memoria")).toBe(true);
    expect(rules).toContain("### Chi scrive");
    expect(rules).not.toContain("## Mappa");
  });
  it("finds `## Memory` too, and nothing when absent", () => {
    expect(memoryRulesSection("## Memory\nrules")).toBe("## Memory\nrules");
    expect(memoryRulesSection("# Nothing here")).toBe("");
  });
  it("lists only concrete note paths, never placeholders or folders", () => {
    expect(explicitRulePaths(memoryRulesSection(agents))).toEqual(["Knowledge/Identity/mario-mental-model.md"]);
  });
});

describe("parseDecisions", () => {
  it("keeps well-formed ops and drops out-of-range or incomplete ones", () => {
    const raw = JSON.stringify({
      decisions: [
        { op: "noop", candidate: 0 },
        { op: "add", candidate: 1, path: "CRM/People/Anna.md", section: "Notes", text: "Leads design" },
        { op: "update", candidate: 2, path: "a.md", oldLine: "- old", newText: "new (dal 2026-09-25; prima old)" },
        { op: "add", candidate: 9, path: "x.md", text: "out of range" },
        { op: "update", candidate: 0, path: "a.md", newText: "missing oldLine" },
      ],
    });
    expect(parseDecisions(raw, 3)).toEqual([
      { op: "noop", candidate: 0 },
      { op: "add", candidate: 1, path: "CRM/People/Anna.md", section: "Notes", text: "Leads design" },
      { op: "update", candidate: 2, path: "a.md", oldLine: "- old", newText: "new (dal 2026-09-25; prima old)" },
    ]);
  });
});

describe("checkTarget guardrails", () => {
  const P = exoPaths("_system");
  const existing = new Set([
    "CRM/People/Anna.md",
    "_system/agent/USER.md",
    "Input/Readwise/Book.md",
    "AGENTS.md",
    "Active/Projects/Exo/AGENTS.md",
    "Knowledge/Identity/mario-mental-model.md",
    "_system/memory/open-loops.md",
    "_system/memory/agents/exo.md",
    "_system/vault-context.md",
    "_system/memory/rules/_index.md",
    "_system/memory/decisions/2026-09-25-x.md",
    "_system/automations/digest.md",
    "_system/agents/emily.md",
    "_system/reports/2026-09-25-digest.md",
    "_system/chats/pricing.md",
    "Private/diary.md",
    "Journal/2026/secret.md",
  ]);
  const env: TargetEnv = {
    exists: (p) => existing.has(p),
    inboxPath: "_system/memory/inbox/2026-09-25.md",
    blocked: harvestBlocklist(P),
    excluded: makeExclusion(["Private/", "/^Journal\\/\\d{4}\\//"], ["Input/"]),
  };
  it("accepts user notes, the mental model, open loops, agent memory and today's inbox", () => {
    for (const p of [
      "CRM/People/Anna.md",
      "/CRM/People/Anna.md",
      "Knowledge/Identity/mario-mental-model.md",
      "_system/memory/open-loops.md",
      "_system/memory/agents/exo.md",
      "_system/memory/inbox/2026-09-25.md",
    ]) {
      expect(checkTarget(p, env), p).toBeNull();
    }
  });
  it("rejects notes that do not exist (no note creation besides the inbox)", () => {
    expect(checkTarget("CRM/People/Nobody.md", env)).toBe("note does not exist");
    expect(checkTarget("_system/memory/inbox/2026-09-24.md", env)).toBe("note does not exist");
  });
  it("rejects kernel and Exo mechanism files, and ANY AGENTS.md / CLAUDE.md", () => {
    for (const p of [
      "_system/agent/USER.md",
      "AGENTS.md",
      "Active/Projects/Exo/AGENTS.md",
      "Some/Where/CLAUDE.md",
      "_system/vault-context.md",
      "_system/memory/rules/_index.md",
      "_system/memory/decisions/2026-09-25-x.md",
      "_system/automations/digest.md",
      "_system/agents/emily.md",
      "_system/reports/2026-09-25-digest.md",
      "_system/chats/pricing.md",
    ]) {
      expect(checkTarget(p, env), p).toBe("agent kernel or Exo mechanism file");
    }
  });
  it("rejects hidden, synced and user-excluded folders, prefix and /regex/ alike", () => {
    expect(checkTarget(".obsidian/plugins/x/data.md", env)).toBe("hidden or config folder");
    expect(checkTarget(".archive/old.md", env)).toBe("hidden or config folder");
    expect(checkTarget("Input/Readwise/Book.md", env)).toBe("synced source folder");
    expect(checkTarget("Sources/Readwise/Book.md", env)).toBe("synced source folder");
    expect(checkTarget("Input/Clip.md", env)).toBe("ignored folder");
    expect(checkTarget("Private/diary.md", env)).toBe("ignored folder");
    expect(checkTarget("Journal/2026/secret.md", env)).toBe("ignored folder");
  });
  it("allows the inbox even under a dot-folder memory root", () => {
    const dotEnv = { ...env, inboxPath: ".exo/memory/inbox/2026-09-25.md" };
    expect(checkTarget(".exo/memory/inbox/2026-09-25.md", dotEnv)).toBeNull();
    expect(checkTarget(".exo/memory/other.md", dotEnv)).toBe("hidden or config folder");
  });
  it("rejects non-markdown and path tricks", () => {
    expect(checkTarget("CRM/People/Anna.pdf", env)).toBe("not a markdown note");
    expect(checkTarget("CRM/../AGENTS.md", env)).toBe("invalid path");
  });
});

const PROV: HarvestProvenance = { convoId: "c-1", chatTitle: "Planning", date: "2026-10-25" };
const TAIL = ` ${formatProvenance({ ...PROV, msgIndex: 0 })}`;

describe("applyAdd", () => {
  const note = "# Anna\n\n## Work\n- Designer\n\n## Personal\n- Lives in Milan\n";
  it("appends a bullet at the end of the named section, ending with the provenance tail", () => {
    expect(applyAdd(note, "Work", "Leads design at Acme", PROV)).toEqual({
      content: `# Anna\n\n## Work\n- Designer\n- Leads design at Acme${TAIL}\n\n## Personal\n- Lives in Milan\n`,
      line: `- Leads design at Acme${TAIL}`,
    });
  });
  it("the tail names the chat, links back to it and carries the date", () => {
    const line = applyAdd(note, "Work", "x fact", PROV)?.line ?? "";
    expect(line).toBe('- x fact [fonte: chat "Planning" (obsidian://exo-chat?id=c-1&msg=0); dal: 2026-10-25]');
  });
  it("does not duplicate a provenance the model wrote itself", () => {
    const line = applyAdd(note, "Work", 'Leads design [fonte: chat "Old" (obsidian://exo-chat?id=zzz&msg=3); dal: 2026-01-01]', PROV)?.line;
    expect(line).toBe(`- Leads design${TAIL}`);
    expect(line?.match(/\[fonte/g)).toHaveLength(1);
  });
  it("strips a model-written changed-fact tail on an add too", () => {
    expect(applyAdd(note, "Work", "Leads design (dal 2026-09-01; prima Designer)", PROV)?.line).toBe(`- Leads design${TAIL}`);
  });
  it("matches the section with or without #s, case-insensitively", () => {
    expect(applyAdd(note, "## personal", "Has a dog", PROV)?.content).toContain(`- Lives in Milan\n- Has a dog${TAIL}\n`);
  });
  it("appends at the end when the section is missing or absent", () => {
    expect(applyAdd(note, "Nope", "x fact", PROV)?.content).toBe(`${note}- x fact${TAIL}\n`);
    expect(applyAdd(note, undefined, "y fact", PROV)?.content).toBe(`${note}- y fact${TAIL}\n`);
  });
  it("writes exactly one line, never a second bullet marker", () => {
    expect(applyAdd("", undefined, "- multi\nline", PROV)?.content).toBe(`- multi line${TAIL}\n`);
  });
  it("the inbox note gets provenance too", () => {
    expect(applyAdd(inboxNote("2026-10-25"), undefined, "Something useful", PROV)?.line).toBe(`- Something useful${TAIL}`);
  });
  it("never lands inside frontmatter: a YAML comment is not a section", () => {
    const fm = "---\ntags: [x]\n# Work\n---\n# Note\nbody\n";
    expect(applyAdd(fm, "Work", "fact", PROV)?.content).toBe(`${fm}- fact${TAIL}\n`);
  });
  it("never uses a heading inside a code fence as a section", () => {
    const code = "# Note\n```md\n## Work\n```\ntext\n";
    expect(applyAdd(code, "Work", "fact", PROV)?.content).toBe(`${code}- fact${TAIL}\n`);
  });
  it("a ~~~ line inside a ``` block is not a fence: the section after it still counts", () => {
    const code = "# Note\n```\n~~~\n```\n## Work\n- Designer\n\n## Other\n- x\n";
    expect(applyAdd(code, "Work", "fact", PROV)?.content).toBe(`# Note\n\`\`\`\n~~~\n\`\`\`\n## Work\n- Designer\n- fact${TAIL}\n\n## Other\n- x\n`);
  });
  it("refuses a note whose frontmatter never closes, and text that is structure", () => {
    expect(applyAdd("---\ntitle: x\n", undefined, "fact", PROV)).toBeNull();
    for (const t of ["# Heading", "| a | b |", "```js", "---"]) expect(applyAdd(note, "Work", t, PROV), t).toBeNull();
  });
  it("refuses text that is only a provenance tail", () => {
    expect(applyAdd(note, "Work", "[fonte: chat \"x\"; dal: 2026-01-01]", PROV)).toBeNull();
  });
});

describe("stripProvenance", () => {
  it("drops a trailing [fonte ...] tail", () => {
    expect(stripProvenance('Fact [fonte: chat "T" (obsidian://exo-chat?id=a&msg=0); dal: 2026-10-25]')).toBe("Fact");
    expect(stripProvenance("Fact [fonte: nota; dal: 2026-10-25]  ")).toBe("Fact");
  });
  it("drops a trailing (dal ...; prima ...) tail, in Italian or English", () => {
    expect(stripProvenance("Team: 6 (dal 2026-09-25; prima 4)")).toBe("Team: 6");
    expect(stripProvenance("Team: 6 (since 2026-09-25; previously 4)")).toBe("Team: 6");
  });
  it("drops both when stacked, and leaves everything else alone", () => {
    expect(stripProvenance("Team: 6 (dal 2026-09-25; prima 4) [fonte: x; dal: 2026-09-25]")).toBe("Team: 6");
    expect(stripProvenance("Founded in (2019) [see below]")).toBe("Founded in (2019) [see below]");
    expect(stripProvenance("Fonte of truth: the vault")).toBe("Fonte of truth: the vault");
  });
});

describe("stripProvenance, bracketed fact text", () => {
  it("leaves wikilinks and bracketed words that are not a source tail", () => {
    expect(stripProvenance("Dati in [[fonte-dati-crm]]")).toBe("Dati in [[fonte-dati-crm]]");
    expect(stripProvenance("Vedi [[fonte-dati-crm]] [fonte: nota; dal: 2026-10-25]")).toBe("Vedi [[fonte-dati-crm]]");
    expect(stripProvenance("Serve una [fonte di verità]")).toBe("Serve una [fonte di verità]");
  });
  it("drops the real [fonte regola 11: ...] variant", () => {
    expect(stripProvenance("Fact [fonte regola 11: AGENTS.md; dal: 2026-10-25]")).toBe("Fact");
  });
  it("drops the update source tail without a dal: too", () => {
    expect(stripProvenance('Team: 6 (dal 2026-10-25; prima Team: 4) [fonte: chat "T" (obsidian://exo-chat?id=a&msg=0)]')).toBe("Team: 6");
  });
});

describe("applyUpdate", () => {
  const note = "## Work\n- Role: designer at Acme\n  - Team: 4\n";
  const SRC = '[fonte: chat "Planning" (obsidian://exo-chat?id=c-1&msg=0)]';
  const U = (content: string, old: string, text: string) => applyUpdate(content, old, text, { ...PROV, date: "2026-10-25" });
  it("replaces exactly one line, keeping its bullet: (dal <today>; prima <old>) then the chat source", () => {
    expect(U(note, "- Role: designer at Acme", "Role: head of design at Acme")).toEqual({
      content: `## Work\n- Role: head of design at Acme (dal 2026-10-25; prima Role: designer at Acme) ${SRC}\n  - Team: 4\n`,
      from: "- Role: designer at Acme",
      to: `- Role: head of design at Acme (dal 2026-10-25; prima Role: designer at Acme) ${SRC}`,
    });
  });
  it("the changed-fact part is the one corrections write", () => {
    const res = U(note, "- Role: designer at Acme", "Role: head");
    expect(res?.to).toBe(`${formatSupersede("- Role: designer at Acme", "Role: head", "2026-10-25")} ${SRC}`);
  });
  it("the source carries no second dal:, the date is in the parenthesis", () => {
    expect(U(note, "- Team: 4", "Team: 6")?.to).not.toMatch(/dal:/);
  });
  it("keeps nested indentation", () => {
    expect(U(note, "- Team: 4", "Team: 6")?.content).toContain(`\n  - Team: 6 (dal 2026-10-25; prima Team: 4) ${SRC}\n`);
  });
  it("does not duplicate a tail the model wrote itself", () => {
    const res = U(note, "- Team: 4", 'Team: 6 (dal 2026-01-01; prima 4) [fonte: x; dal: 2026-01-01]');
    expect(res?.to).toBe(`  - Team: 6 (dal 2026-10-25; prima Team: 4) ${SRC}`);
  });
  it("an old line that already holds a (dal; prima) tail nests nothing", () => {
    const doc = "- Team: 4 (dal 2026-01-01; prima 2)\n";
    expect(U(doc, "- Team: 4 (dal 2026-01-01; prima 2)", "Team: 6")?.to).toBe(`- Team: 6 (dal 2026-10-25; prima Team: 4) ${SRC}`);
  });
  it("keeps the old line's source inside prima", () => {
    const doc = "- Team: 4 [fonte: nota; dal: 2026-01-01]\n";
    expect(U(doc, "- Team: 4 [fonte: nota; dal: 2026-01-01]", "Team: 6")?.to).toBe(
      `- Team: 6 (dal 2026-10-25; prima Team: 4 [fonte: nota; dal: 2026-01-01]) ${SRC}`,
    );
  });
  it("an old line with both tails drops only the changed-fact tail and keeps its source", () => {
    const old = "- Team: 4 (dal 2026-01-01; prima 2) [fonte: nota B]";
    expect(U(`${old}\n`, old, "Team: 6")?.to).toBe(`- Team: 6 (dal 2026-10-25; prima Team: 4 [fonte: nota B]) ${SRC}`);
  });
  it("takes a trailing block anchor off the old line and puts it back at the end of the new one", () => {
    const old = "- Team: 4 [fonte: nota; dal: 2026-01-01] ^exo-abc123";
    const res = U(`${old}\n`, old, "Team: 6");
    expect(res?.to).toBe(`- Team: 6 (dal 2026-10-25; prima Team: 4 [fonte: nota; dal: 2026-01-01]) ${SRC} ^exo-abc123`);
    expect(res?.to.match(/\^exo-abc123/g)).toHaveLength(1);
  });
  it("an anchored line with no source keeps its anchor last", () => {
    expect(U("- Team: 4 ^exo-q1\n", "- Team: 4 ^exo-q1", "Team: 6")?.to).toBe(`- Team: 6 (dal 2026-10-25; prima Team: 4) ${SRC} ^exo-q1`);
  });
  it("refuses a line that is missing or not unique", () => {
    expect(U(note, "- Role: CEO", "x")).toBeNull();
    expect(U("- a\n- a\n", "- a", "b")).toBeNull();
    expect(U(note, "   ", "b")).toBeNull();
  });
  it("refuses frontmatter, headings, table rows, fences, rules and code, whatever the model says", () => {
    const doc = [
      "---",
      "status: beta",
      "---",
      "## Status",
      "| k | v |",
      "```",
      "status = beta",
      "```",
      "---",
      "- plain line",
    ].join("\n");
    for (const old of ["status: beta", "## Status", "| k | v |", "```", "status = beta", "---"]) {
      expect(U(doc, old, "live"), old).toBeNull();
    }
    expect(U(doc, "- plain line", "## Injected heading")).toBeNull();
    expect(U(doc, "- plain line", "new plain line")?.to).toBe(`- new plain line (dal 2026-10-25; prima plain line) ${SRC}`);
  });
});

describe("buildDecidePrompt", () => {
  const prompt = buildDecidePrompt({
    today: "2026-10-25",
    rules: "## Memoria\nCome si scrive: `[fonte: <chat>; dal: AAAA-MM-GG]`",
    routingNotes: [],
    inboxPath: "_exo/memory/inbox/2026-10-25.md",
    agentLessonPath: "_exo/memory/agents/exo.md",
    items: [],
  });
  it("no longer asks the model for the changed-fact or provenance format", () => {
    expect(prompt).not.toMatch(/since YYYY-MM-DD|previously|changed-fact format/);
  });
  it("tells the model the code adds the provenance and the trace", () => {
    expect(prompt).toMatch(/do not write (a )?(source|provenance)/i);
  });
});

describe("matchingLines", () => {
  it("returns plain lines sharing a keyword, verbatim, never structure", () => {
    const content = "---\nowner: anna\n---\n# Acme\n- Founded 2019\n- Design team led by Anna\n## Anna\n| anna | lead |\n```\nanna()\n```\n";
    expect(matchingLines(content, ["anna"])).toEqual(["- Design team led by Anna"]);
  });
});

describe("safeTitle", () => {
  it("replaces a title carrying a credential, and an empty one, with 'chat'", () => {
    expect(safeTitle("Pricing call")).toBe("Pricing call");
    expect(safeTitle("setup with OPENAI_API_KEY=sk-abc123def456")).toBe("chat");
    expect(safeTitle("  ")).toBe("chat");
  });
});

describe("commit messages", () => {
  it("names the harvest and the chat", () => {
    expect(harvestCommitMessage(3, "Pricing\nreview")).toBe("exo: memory harvest: 3 scritture (Pricing review)");
    expect(harvestCommitMessage(1, "")).toBe("exo: memory harvest: 1 scritture (chat)");
    expect(revertCommitMessage("abc123")).toBe("exo: memory revert: abc123");
  });
});
