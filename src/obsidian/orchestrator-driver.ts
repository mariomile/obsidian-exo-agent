/**
 * Orchestrator driver (B5) — the impure controller that owns the orchestration
 * runtime. It is the ONLY piece that ties the three pure/queued layers together:
 *
 *   - the pure reducer (`src/core/orchestrator.ts`) decides transitions + effects,
 *   - the queued store (`src/obsidian/task-store.ts`) persists every mutation
 *     through the shared `WriteQueue`,
 *   - the plugin-level convo-state emitter (`src/core/convo-state.ts`, B4) feeds
 *     conversation-lifecycle events in,
 *   - `startTaskConversation` (B4) spawns chats and hands back a convo id.
 *
 * The driver holds an in-memory task list as the board's live source of truth,
 * derived at `start()` from `store.load()` + boot `reconcile()`, then evolved by
 * feeding events into `reduce()`. Every transition it applies is also persisted
 * through the store, and every `spawn-chat` effect is executed by spawning a
 * conversation and recording the returned convo id back onto the task (both in
 * memory and on disk).
 *
 * Nothing here imports `obsidian` — it depends only on injected callbacks
 * (`DriverDeps`), so the whole controller is unit-testable with fakes. The real
 * deps are built by `obsidian/orchestration-wiring.ts` and the driver is owned
 * by the PLUGIN (`obsidian/orchestration.ts`), not by the board: delegated work
 * has to run whether or not the board tab happens to be open. The board is a
 * renderer and a control surface over this driver, nothing more.
 */

import {
  reconcile,
  reduce,
  withholdSpawns,
  type ConvoSnapshot,
  type OrchestratorConfig,
  type OrchestratorEffect,
  type OrchestratorEvent,
  type OrchestratorResult,
} from "../core/orchestrator";
import type { ConvoStateEvent, ConvoStateListener, Unsubscribe } from "../core/convo-state";
import type { TaskEntry, TaskPatch, TaskStatus } from "../core/tasks";
import { buildExcerpt, outcomeFromState, REPORT_DEBOUNCE_MS, type ChildReport } from "../core/child-reports";
import { PARENT_STOPPED } from "../core/delegation";

/** The driver-facing slice of the B3 `TaskStore` (kept structural so tests can
 *  inject a fake without the real store / WriteQueue). */
export interface DriverStore {
  load(): Promise<{ tasks: TaskEntry[]; warnings: string[] }>;
  update(id: string, patch: TaskPatch): Promise<TaskEntry>;
  move(id: string, status: TaskStatus, order: number): Promise<TaskEntry>;
  archive(id: string): Promise<TaskEntry>;
}

/** Everything the driver needs from the outside world. All injected so the
 *  controller stays pure of `obsidian` and fully unit-testable. */
export interface DriverDeps {
  /** The task ledger (B3). */
  store: DriverStore;
  /** Subscribe to the plugin convo-state emitter (B4). Returns an unsubscribe. */
  subscribe(listener: ConvoStateListener): Unsubscribe;
  /** Spawn a chat for a task and return its new convo id (B4
   *  `startTaskConversation`). Rejects on failure. `parent` is passed through
   *  so the view can stamp `parentConvoId` on the new conversation and keep it
   *  out of the tab strip. */
  spawn(prompt: string, opts?: { model?: string; parent?: string }): Promise<string>;
  /** Boot-time convo liveness read for a recorded convo id (B4
   *  `readConvoState`, adapted to the reducer's `ConvoSnapshot` shape). */
  liveness(convoId: string): ConvoSnapshot;
  /** Current scheduler config (reads `orchestrationMaxConcurrent` live). */
  config(): OrchestratorConfig;
  /** Surface a user-visible error (Obsidian `Notice`). */
  notify(message: string): void;
  /** Called after every state change so the board can re-render. */
  onChange(tasks: TaskEntry[]): void;
  /** Last assistant text of a convo, for the child-report excerpt. Absent →
   *  reports carry an empty excerpt. */
  lastAssistantText?(convoId: string): string;
  /** Deliver a finished child's report to its parent. Absent → child
   *  reporting is off. */
  onChildReport?(report: ChildReport): void;
  /**
   * Is there a UI able to host a conversation right now?
   *
   * Absent → assumed yes (the shape every test and the old board-owned driver
   * used). Returning `false` makes the driver WITHHOLD promotions instead of
   * spawning into the void: the tasks stay `queued`, hold no slot, get no error
   * badge and send no report. This exists because the driver now starts with the
   * plugin, not with the board tab, so the first scheduler pass routinely runs
   * before any ChatView is mounted — and `spawn` answers that situation with the
   * same empty string it uses for a real failure.
   */
  canSpawn?(): boolean;
  /** Called when a promotion was withheld for want of a host, so the shell can
   *  arm a retry. Fires once per withheld dispatch, not once per task. */
  onSpawnHostMissing?(): void;
}

/**
 * Maps a chat-side convo-state event onto the reducer's `ConvoEvent` vocabulary.
 * `turn-start`/`turn-end` map 1:1; `needs-input`/`stopped`/`error` map to the
 * same-named reducer events (the reducer parks all three in `needs-input` with
 * a reason badge, distinguished by `inputReason`).
 */
function toOrchestratorEvent(e: ConvoStateEvent): OrchestratorEvent {
  switch (e.state) {
    case "turn-start":
      return { type: "turn-start", convoId: e.convoId };
    case "turn-end":
      return { type: "turn-end", convoId: e.convoId };
    case "needs-input":
      return { type: "needs-input", convoId: e.convoId };
    case "stopped":
      return { type: "stopped", convoId: e.convoId };
    case "error":
      return { type: "error", convoId: e.convoId };
  }
}

/**
 * Did `event` take the task owning its convo out of `running`?
 *
 * The reducer already refuses to settle anything that isn't `running` — that is
 * what makes a second `turn-end` on an idle child a no-op. This reads the SAME
 * fact off the transition instead of restating the rule, so the two can't drift:
 * a settling transition is exactly `running` → not-`running` for that convo.
 * Events with no convo (enqueue, move, slot-freed…) never settle a child.
 */
function settledRunningTask(
  before: TaskEntry[],
  after: TaskEntry[],
  event: OrchestratorEvent
): boolean {
  if (!("convoId" in event)) return false;
  const prev = before.find((t) => t.convo === event.convoId);
  const next = after.find((t) => t.convo === event.convoId);
  if (!prev || !next) return false;
  return prev.status === "running" && next.status !== "running";
}

export class OrchestratorDriver {
  private tasks: TaskEntry[] = [];
  private unsubscribe: Unsubscribe | null = null;
  /** Serializes reducer dispatches so overlapping async events (convo bursts,
   *  spawn awaits) can never interleave a read-modify-write of `this.tasks`. */
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  /** Reports awaiting delivery, keyed by task id — a child that ends several
   *  turns in quick succession collapses to ONE report, not several. */
  private readonly pendingReports = new Map<string, ChildReport>();
  private reportTimer: number | null = null;

  constructor(private readonly deps: DriverDeps) {}

  /** The live task list — the board's render source. Defensive copy. */
  snapshot(): TaskEntry[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /**
   * Load tasks, reconcile against live convo state, subscribe to convo events.
   * Idempotent: a second call while running is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const loaded = await this.deps.store.load();
    // Reconcile persisted statuses against the live convo store (per B2's pure
    // matrix). Dead convos get chatMissing; idle→review; streaming→running.
    const convos = new Map<string, ConvoSnapshot>();
    for (const t of loaded.tasks) {
      if (t.convo) convos.set(t.convo, this.deps.liveness(t.convo));
    }
    const reconciled = reconcile(loaded.tasks, convos, this.deps.config());
    this.tasks = reconciled.tasks;

    // Persist any status/flag corrections reconciliation produced so the on-disk
    // ledger matches the reconciled view (best-effort; never throws into boot).
    await this.persistDiff(loaded.tasks, this.tasks);

    this.unsubscribe = this.deps.subscribe((e) => this.onConvoEvent(e));
    this.emitChange();

    // Reconciliation only corrects active statuses and returns no effects — it
    // never promotes `queued` work. Any task left `queued` from a prior session
    // (or a leaked slot) with a free slot must start now, so run one scheduler
    // pass on boot to promote eligible queued tasks and spawn their convos.
    await this.dispatch({ type: "slot-freed" });
  }

  /**
   * Stop the driver: unsubscribe from convo events and drop the in-memory
   * runtime state. Touches NO markdown and leaves running conversations alive
   * (they simply become normal chats). Safe to call when never started.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.reportTimer) {
      window.clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    // DELIVER what is pending, never drop it. The driver is stopped on plugin
    // unload, on an orchestration hot-disable, and on every ledger reload (which
    // rebuilds it), and any of those can land inside the report debounce. A
    // dropped report is the child's output gone for good: the queue on the
    // parent is the only route it has back.
    this.flushReports();
    this.tasks = [];
    this.started = false;
  }

  // --- User actions -------------------------------------------------------

  /** Backlog → Queued (scheduler may promote to Running immediately). */
  async enqueue(taskId: string): Promise<void> {
    await this.dispatch({ type: "enqueue", taskId });
  }

  /**
   * Re-run the scheduler. The shell calls this when something outside the
   * reducer's world changed in a way that could unblock queued work — today
   * that is exactly one thing: a conversation host appeared after a promotion
   * was withheld (see `canSpawn`).
   */
  async pump(): Promise<void> {
    await this.dispatch({ type: "slot-freed" });
  }

  /**
   * "Run" a task: for a normal backlog task this is `enqueue`; for a
   * `chat-missing` task (its recorded convo is dead) this re-queues it so the
   * scheduler spawns a FRESH convo and records the new id. Either way it routes
   * through `enqueue` on the reducer — a task that isn't in `backlog` (e.g. a
   * chat-missing task still marked `running`) is first moved back to `queued`.
   */
  async run(taskId: string): Promise<void> {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (t.status === "backlog") {
      await this.enqueue(taskId);
      return;
    }
    // Re-run path (chat-missing, needs-input, review, or a stale running):
    // move to queued at the front so the scheduler promotes + spawns fresh.
    await this.move(taskId, "queued", -1);
  }

  /** Review → Done. User-action-only; ignored elsewhere by the reducer. */
  async markDone(taskId: string): Promise<void> {
    await this.dispatch({ type: "mark-done", taskId });
  }

  /**
   * Archive a card: hides it from the board (the `archived` column is not
   * rendered) while KEEPING its markdown block in tasks.md. Available from the
   * card context menu on any column, so it goes straight through the store's
   * dedicated `archive` path (which sets `archived` regardless of the current
   * status) rather than the reducer's `done → archived` transition. Serialized
   * on the dispatch chain so it can't race a convo event.
   */
  archive(taskId: string): Promise<void> {
    const run = this.chain.then(() => this.applyArchive(taskId));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyArchive(taskId: string): Promise<void> {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    this.tasks = this.tasks.map((x) => (x.id === taskId ? { ...x, status: "archived" } : x));
    await this.deps.store.archive(taskId).catch(() => undefined);
    // Archiving a running task frees a slot — let the scheduler fill it.
    const result = this.reduceGated(this.tasks, { type: "slot-freed" });
    const before = this.tasks;
    this.tasks = result.tasks;
    await this.persistDiff(before, this.tasks);
    this.emitChange();
    for (const effect of result.effects) await this.runEffect(effect);
  }

  /** Drag/move to an explicit column + order (board drag & drop). */
  async move(taskId: string, target: TaskStatus, order: number): Promise<void> {
    await this.dispatch({ type: "move", taskId, target, order });
  }

  // --- Convo events -------------------------------------------------------

  private onConvoEvent(e: ConvoStateEvent): void {
    // Chained after the dispatch settles (not a synchronous sibling call):
    // `task.convo` is only recorded once `runEffect`'s `await spawn()`
    // resolves, inside SOME earlier dispatch on `this.chain`. Because
    // `dispatch()` always chains onto `this.chain`, this event's own dispatch
    // cannot settle before that earlier one does — so by the time we get
    // here, the owner lookup below is guaranteed to see an up-to-date
    // `task.convo`. Reading `this.tasks` synchronously (the previous shape)
    // raced a child that fails to spawn near-instantly: the convo-state event
    // could reach `onConvoEvent` before the promoting dispatch had recorded
    // `task.convo`, silently dropping the report. `e` is kept in closure so
    // its `reason` (needed by `outcomeFromState`) survives.
    //
    // The dispatch reports back whether THIS event actually settled the owning
    // task (see `applyEvent`); only then is there a report to make. Reading the
    // status here instead would be wrong in both directions — see
    // `maybeQueueChildReport`.
    void this.dispatch(toOrchestratorEvent(e)).then((settled) => {
      if (settled) this.maybeQueueChildReport(e);
    });
  }

  /**
   * Child reporting: a task WITH a parent that reached an outcome tells its
   * parent. Never inline — batched behind the debounce so a child that ends
   * several turns in quick succession produces one message, not five.
   *
   * Called ONLY on an actual settling transition, never on every outcome-shaped
   * event. A settled child stays a normal chat: it sits in `review` (or
   * `needs-input`) until a human clears it, and Mario can keep working in it.
   * Every one of those later turns emits `turn-end` — the reducer no-ops,
   * because only a `running` task settles — so reporting off the event alone
   * re-told the parent "the task you delegated is done", forever, each time
   * with an excerpt from work it never asked for.
   */
  private maybeQueueChildReport(e: ConvoStateEvent): void {
    if (!this.deps.onChildReport) return;
    const owner = this.tasks.find((t) => t.convo === e.convoId);
    if (!owner?.parent) return;
    const outcome = outcomeFromState(e.state, e.reason);
    if (!outcome) return;
    this.pendingReports.set(owner.id, {
      taskId: owner.id,
      childConvoId: e.convoId,
      parentConvoId: owner.parent,
      title: owner.title,
      outcome,
      excerpt: buildExcerpt(this.deps.lastAssistantText?.(e.convoId) ?? ""),
      at: Date.now(),
    });
    this.scheduleReportFlush();
  }

  private scheduleReportFlush(): void {
    if (this.reportTimer) window.clearTimeout(this.reportTimer);
    this.reportTimer = window.setTimeout(() => {
      this.reportTimer = null;
      this.flushReports();
    }, REPORT_DEBOUNCE_MS);
  }

  /** Hand every queued report to the consumer and empty the queue. */
  private flushReports(): void {
    const batch = [...this.pendingReports.values()];
    this.pendingReports.clear();
    for (const report of batch) {
      try {
        this.deps.onChildReport?.(report);
      } catch {
        // A failing consumer must never break orchestration — same
        // isolation contract as the convo-state channel's listeners.
      }
    }
  }

  // --- Core dispatch ------------------------------------------------------

  /**
   * Feed one event through the pure reducer, persist the resulting transitions,
   * and execute any spawn effects — all serialized on `this.chain` so async
   * spawns can't interleave. Returns when this event's work has settled, and
   * resolves with whether this event took the convo's task OUT of `running`
   * (see `settledRunningTask`). Non-convo events always resolve `false`.
   */
  private dispatch(event: OrchestratorEvent): Promise<boolean> {
    const run = this.chain.then(() => this.applyEvent(event));
    // Advance the chain on a branch that swallows rejection, so one failed
    // dispatch never poisons later ones (same discipline as WriteQueue).
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * `reduce`, then withhold the promotions when no UI can host a conversation.
   * EVERY reducer call goes through here — the scheduler runs from three places
   * (a dispatched event, an archive freeing a slot, a failed spawn refilling
   * one) and a gate that only covered one of them would still burn tasks.
   */
  private reduceGated(before: TaskEntry[], event: OrchestratorEvent): OrchestratorResult {
    const result = reduce(before, event, this.deps.config());
    if (result.effects.length === 0 || this.deps.canSpawn?.() !== false) return result;
    this.deps.onSpawnHostMissing?.();
    return withholdSpawns(before, result);
  }

  private async applyEvent(event: OrchestratorEvent): Promise<boolean> {
    const before = this.tasks;
    const result: OrchestratorResult = this.reduceGated(before, event);
    this.tasks = result.tasks;
    // Computed against the pre-reduce list, INSIDE the serialized chain, so it
    // reads the same state the reducer just judged. Doing this in
    // `onConvoEvent` instead would race the chain: another dispatch can run
    // between this one settling and its `.then` callback.
    const settled = settledRunningTask(before, result.tasks, event);

    // Persist non-effect transitions (status/order/badge changes) first so the
    // ledger reflects the move even if a spawn later fails.
    await this.persistDiff(before, this.tasks);
    this.emitChange();

    // Execute effects (spawns). Each records its convo id back onto the task.
    for (const effect of result.effects) {
      await this.runEffect(effect);
    }
    return settled;
  }

  private async runEffect(effect: OrchestratorEffect): Promise<void> {
    if (effect.type !== "spawn-chat") return;
    try {
      const task = this.tasks.find((t) => t.id === effect.taskId);
      const convoId = await this.deps.spawn(effect.prompt, {
        ...(effect.model ? { model: effect.model } : {}),
        ...(task?.parent ? { parent: task.parent } : {}),
      });
      // A falsy/empty convo id is a FAILURE, not a success: the real
      // `startTaskConversation` (main.ts) and `askInNewConversation` (view.ts)
      // both RESOLVE with "" when the view can't be resolved or the prompt is
      // empty. Recording "" would leave the task stuck `running` forever with a
      // convo id that matches no convo-state event. Route it through the catch.
      if (!convoId) throw new Error("chat failed to start");
      // Record the convo id (and clear any stale chat-missing flag) in memory
      // and on disk. The task is already `running` from the reducer.
      this.tasks = this.tasks.map((t) =>
        t.id === effect.taskId ? { ...t, convo: convoId, chatMissing: undefined } : t
      );
      await this.deps.store.update(effect.taskId, { convo: convoId }).catch(() => undefined);
      this.emitChange();
    } catch (err) {
      // Spawn/write failure → drop the task to needs-input with an error badge,
      // surface a Notice + (implicitly) a badge on the card via the state.
      const msg = err instanceof Error ? err.message : String(err);
      const failedTask = this.tasks.find((t) => t.id === effect.taskId);
      // Its parent was stopped mid-spawn: the stop meant this task too.
      // Archived quietly, never shown as a failure (core/delegation.ts).
      const cancelled = msg === PARENT_STOPPED;
      this.tasks = this.tasks.map((t) =>
        t.id !== effect.taskId
          ? t
          : cancelled
            ? { ...t, status: "archived", chatMissing: undefined }
            : { ...t, status: "needs-input", inputReason: "error", chatMissing: undefined }
      );
      if (cancelled) await this.deps.store.archive(effect.taskId).catch(() => undefined);
      else {
        await this.deps.store.update(effect.taskId, { status: "needs-input" }).catch(() => undefined);
        this.deps.notify(`Couldn't start task: ${msg}`);
      }
      this.emitChange();

      // A child that never got a convo never emits a convo-state event, so
      // `maybeQueueChildReport` never fires for it — the parent would wait
      // forever on a report that can never arrive. Queue one directly, through
      // the SAME batched/debounced path (keyed by task id), so a parent with
      // several children in flight still gets one message, not a partial set.
      if (!cancelled && this.deps.onChildReport && failedTask?.parent) {
        this.pendingReports.set(failedTask.id, {
          taskId: failedTask.id,
          // No convo was ever created — hence `parentConvoId` on the report:
          // the consumer routes by it and never by looking this id up.
          childConvoId: "",
          parentConvoId: failedTask.parent,
          title: failedTask.title,
          outcome: "error",
          excerpt: buildExcerpt(msg),
          at: Date.now(),
        });
        this.scheduleReportFlush();
      }

      // The failed task freed the running slot it was promoted into. Re-run the
      // scheduler so that slot is refilled by the next eligible queued task —
      // otherwise a transient failure (e.g. CLI momentarily down) permanently
      // leaks a slot when TWO tasks are promoted together in one fillSlots and
      // one fails. Mirror applyArchive's slot-freed dispatch. A cascading
      // failure re-enters runEffect via the effect loop below; each failure
      // frees only its own slot, so the recursion terminates.
      const result = this.reduceGated(this.tasks, { type: "slot-freed" });
      const before = this.tasks;
      this.tasks = result.tasks;
      await this.persistDiff(before, this.tasks);
      this.emitChange();
      for (const nextEffect of result.effects) await this.runEffect(nextEffect);
    }
  }

  /**
   * Persist the fields that changed between two task lists through the store.
   * A status/order change → `store.move`; other field changes (badges) →
   * `store.update` with the changed metadata. Best-effort: a persist failure is
   * swallowed (the in-memory view stays authoritative; the board still renders).
   */
  private async persistDiff(before: TaskEntry[], after: TaskEntry[]): Promise<void> {
    const beforeById = new Map(before.map((t) => [t.id, t]));
    for (const t of after) {
      const prev = beforeById.get(t.id);
      if (!prev) continue;
      const statusChanged = prev.status !== t.status;
      const orderChanged = (prev.order ?? undefined) !== (t.order ?? undefined);
      if (statusChanged || orderChanged) {
        await this.deps.store.move(t.id, t.status, t.order ?? 0).catch(() => undefined);
      }
    }
  }

  private emitChange(): void {
    this.deps.onChange(this.snapshot());
  }
}
