/**
 * Prompt surfaces for the memory layer: the short standing notes appended to the
 * boot preamble that tell the model which memory capabilities exist and when to
 * use them. Pure string templates, one call site each (`bootPreambleFor` in
 * `obsidian/memory.ts`).
 */

/** Prompt surface for automatic memory: the vault IS the memory, Exo captures
 *  after each chat and recalls before each turn, so the model neither stores
 *  nor searches a parallel memory. Appended when capture or recall is on. */
export const autoMemoryNote = (opts: { recall: boolean; chats: boolean }): string =>
  "### Memory\n" +
  "Your memory is this vault: durable facts live in the user's own notes. After a chat goes idle, Exo reads it and adds or updates one-line facts in the right notes by itself, so you do not need to save anything to remember it. " +
  (opts.recall
    ? "Before each message, Exo may prepend a `[vault-recall]` block with related notes and past chats: it is BACKGROUND, never the current conversation. When the user points back ('continua', 'as above'), resolve it from THIS thread. "
    : "") +
  (opts.chats ? "Use `recent_chats` when the user asks what you discussed recently." : "");

/** Prompt surface for the identity layer: appended when the agent folder is on
 *  and `rethink_memory` is registered. Explains WHEN to rethink (world-model
 *  change) and the rationale requirement for SOUL/USER. */
export const agentFolderNote = (agentDir: string): string =>
  "### Identity: `rethink_memory`\n" +
  `Your shared kernel lives in \`${agentDir}/\` (SOUL, USER, NOW) and is already in your boot context above. ` +
  "Call `rethink_memory` only when your MODEL OF THE WORLD changes: a shifted priority (NOW.md), a durable update to how you understand the user (USER.md) or to how you behave (SOUL.md). Pass a rationale for USER.md and SOUL.md: it is shown in the feed diff, where the user reviews and can undo after the fact. Not for single facts: those land in the vault automatically.";
