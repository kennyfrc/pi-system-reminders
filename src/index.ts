/**
 * Extension-facing API. Self-installing: the FIRST caller of `registerReminder`
 * with a given `pi` also installs the single `context` event handler (plus a
 * passive `before_agent_start` listener that captures the context files for
 * durable evaluation) for that instance (idempotent). Clients just depend on
 * this package and call `registerReminder` from their own default export — no
 * need to list pi-system-reminders as a separate extension in settings.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyReminders, DEFAULT_BUDGET_CHARS, renderDurableBlock } from "./apply.js";
import { SYSTEM_REMINDER_CUSTOM_TYPE, type Reminder } from "./types.js";

export type { Gate, Reminder, ReminderContext, SystemReminderDetails } from "./types.js";
export { SYSTEM_REMINDER_CUSTOM_TYPE } from "./types.js";
export { applyReminders, composeBlock, gateMatches, renderDurableBlock, DEFAULT_BUDGET_CHARS } from "./apply.js";

/**
 * Per-`pi` reminder registries. Keyed by the ExtensionAPI instance so multiple
 * logical agents (if ever present) don't cross-contaminate, and so the registry
 * is garbage-collected with the instance.
 */
const stores = new WeakMap<ExtensionAPI, Reminder[]>();
const installed = new WeakSet<ExtensionAPI>();

/**
 * Context files pi loaded for the system prompt at this session's start
 * (captured passively from before_agent_start; cleared on session_start).
 * Feeds durable (session:start) content evaluation only.
 */
const capturedFiles = new WeakMap<
  ExtensionAPI,
  ReadonlyArray<{ path: string; content: string }>
>();

/** Fallback already-sent guard for contexts without a sessionManager. */
const sentWithoutSessionManager = new WeakSet<ExtensionAPI>();

/**
 * Register (or replace, by `id`) a reminder on `pi`. Idempotently installs the
 * handlers bound to this `pi` on first registration.
 *
 * - `lifetime: "transient"` requires a turn/call/tool gate and rides the
 *   wire-only context channel, re-derived every time its gate fires.
 * - `lifetime: "durable"` requires `on: "session:start"`: content is
 *   evaluated once at the session's first user prompt (with the context files
 *   pi loaded for the system prompt) and PERSISTED as a hidden session
 *   message placed immediately before that prompt — the same user-role
 *   `<system_reminder>` wire shape as transient blocks, marked
 *   `durable="true"`. It replays in every subsequent request and on resume.
 *   Already-sent detection walks the active branch's session entries, so
 *   branching to a point before the block re-derives and re-sends it once
 *   there.
 */
export function registerReminder(pi: ExtensionAPI, reminder: Reminder): void {
  if (reminder.lifetime === "durable" && reminder.on !== "session:start") {
    throw new Error(
      `pi-system-reminders: durable reminder "${reminder.id}" must use on: "session:start" ` +
        `(got "${reminder.on}"). Durable content is delivered once per session at the ` +
        `first user prompt, which only the session:start edge can guarantee.`,
    );
  }
  if (reminder.lifetime === "transient" && reminder.on === "session:start") {
    throw new Error(
      `pi-system-reminders: transient reminder "${reminder.id}" cannot use on: "session:start" ` +
        `(transient blocks are re-derived per turn on the wire path). ` +
        `Use lifetime: "durable" for once-per-session delivery.`,
    );
  }

  let arr = stores.get(pi);
  if (!arr) {
    arr = [];
    stores.set(pi, arr);
  }
  const idx = arr.findIndex((r) => r.id === reminder.id);
  if (idx >= 0) arr[idx] = reminder;
  else arr.push(reminder);

  if (!installed.has(pi)) {
    installed.add(pi);
    pi.on("session_start", () => {
      capturedFiles.delete(pi);
      sentWithoutSessionManager.delete(pi);
    });
    // Durable delivery + passive capture. The files are replayed into durable
    // content at this edge; when durable content applies and no durable entry
    // exists on the active branch yet, the rendered block is PERSISTED via
    // pi.sendMessage — placed immediately before the prompt pi is about to
    // process (sendMessage appends to the session messages; the user prompt
    // follows). Nothing is returned from this handler: the persisted message
    // is the delivery, and it replays from the transcript on every later
    // request and on resume.
    pi.on("before_agent_start", async (event, ctx) => {
      const files = contextFilesOf(event);
      if (files) capturedFiles.set(pi, files);
      const reminders = stores.get(pi);
      const durable = reminders?.filter((r) => r.lifetime === "durable") ?? [];
      if (durable.length === 0) return undefined;
      // Already sent? The branch walk is authoritative (branch-aware); the
      // in-memory set only guards degenerate contexts without a sessionManager
      // and is re-armed on session_start.
      const sm = sessionManagerOf(ctx);
      if (sm ? hasDurableEntryOnBranch(sm) : sentWithoutSessionManager.has(pi)) return undefined;
      const block = renderDurableBlock(durable, capturedFiles.get(pi));
      if (!block) return undefined; // not applicable yet; re-evaluated next prompt
      sentWithoutSessionManager.add(pi);
      try {
        await pi.sendMessage(
          {
            customType: SYSTEM_REMINDER_CUSTOM_TYPE,
            content: [{ type: "text" as const, text: block.text }],
            display: false,
            details: { placement: "durable-preamble" as const, reminderIds: block.reminderIds },
          },
          { triggerTurn: false },
        );
      } catch {
        sentWithoutSessionManager.delete(pi); // Never break the prompt; retried next prompt.
      }
      return undefined;
    });
    pi.on("context", (event) => {
      const reminders = stores.get(pi);
      if (!reminders || reminders.length === 0) return undefined;
      // Transient only: durable content is persisted at session:start and
      // replays from the transcript; injecting it here would double-deliver.
      const next = applyReminders(event.messages, reminders, DEFAULT_BUDGET_CHARS);
      // Same reference => nothing fired => no-op (avoids needless array churn).
      return next === event.messages ? undefined : { messages: next };
    });
  }
}

/** Minimal session-manager surface the branch walk needs. */
interface SessionManagerLike {
  getLeafId(): string | null;
  getEntry(id: string): { parentId?: string | null; type?: string; customType?: string } | undefined;
}

/** The extension context's sessionManager, when present and shaped as needed. */
function sessionManagerOf(ctx: unknown): SessionManagerLike | undefined {
  const sm = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!sm || typeof sm !== "object") return undefined;
  const candidate = sm as Partial<SessionManagerLike>;
  if (typeof candidate.getLeafId !== "function" || typeof candidate.getEntry !== "function") return undefined;
  return candidate as SessionManagerLike;
}

/**
 * Does the active branch of the session already carry a persisted durable
 * block (a custom_message entry with our customType)? Walks the entry chain
 * from the leaf to the root via parentId; entries on sibling branches are
 * invisible, so a branch taken before the block re-derives and re-sends it.
 */
function hasDurableEntryOnBranch(sm: SessionManagerLike): boolean {
  let id = sm.getLeafId();
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = sm.getEntry(id);
    if (!entry) break;
    if (entry.type === "custom_message" && entry.customType === SYSTEM_REMINDER_CUSTOM_TYPE) return true;
    id = entry.parentId ?? null;
  }
  return false;
}

/** The context files pi loaded for the system prompt, if the event carries them. */
function contextFilesOf(
  event: unknown,
): ReadonlyArray<{ path: string; content: string }> | undefined {
  const options = (event as { systemPromptOptions?: { contextFiles?: unknown } }).systemPromptOptions;
  const files = options?.contextFiles;
  if (!Array.isArray(files)) return undefined;
  return files.filter(
    (f): f is { path: string; content: string } =>
      !!f && typeof (f as { path?: unknown }).path === "string" && typeof (f as { content?: unknown }).content === "string",
  );
}

/** Test/diagnostics helper: read the registered reminders for a `pi`. */
export function getReminders(pi: ExtensionAPI): readonly Reminder[] {
  return stores.get(pi) ?? [];
}
