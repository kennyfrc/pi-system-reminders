/**
 * pi-system-reminders
 *
 * A durability state machine for the Pi `context` event, ported from the ai21
 * `agent_stream_event_source.rb` split-part taxonomy. The vocabulary:
 *
 *   "reminders are transient blocks pinned to a clock edge; the manager fires
 *    them into one distinct reminder item adjacent to the request tail, then
 *    discards them — they are never persisted and never accumulate."
 *
 * Durable reminders are the explicit exception: whole-session policy context
 * (AGENTS.md, skill catalogs) that must NOT vanish after the first turn. They
 * are PERSISTED as a hidden session message once, immediately before the
 * session's first user prompt, and replay in every later request and on
 * resume — a synthetic system prompt riding the same user-role
 * <system_reminder> wire shape as transient blocks, marked durable="true".
 *
 * See devdocs/designs/pi-system-reminders.html for the full design.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * A clock edge — the moment within the agent loop at which a reminder may fire.
 *
 * The four clocks: session → turn → call → tool. Edges pick the firing points:
 *  - `session:start` — the session's FIRST user prompt (the
 *    before_agent_start edge). Durable reminders only: content is evaluated
 *    once there, with the context files pi loaded for the system prompt, and
 *    PERSISTED as a session message placed immediately before that first
 *    user prompt. Because the block lives in the session transcript it
 *    replays in every subsequent request and on resume; the gate never
 *    re-fires while a durable entry exists on the active branch. Branching
 *    to a point before the block re-derives and re-sends it once there.
 *  - `turn:start` — the FIRST LLM call of a user turn (tail message is a plain
 *    user message). The transient, per-turn policy. This is the default and is
 *    what re-derived-each-turn reminders use (flow trigger maps, todo state,
 *    env drift). Continuation calls after tool results do NOT fire.
 *  - `call:every` — every LLM call, including continuations. Use sparingly:
 *    it pays the block's cost on every request in the loop. Legitimate for
 *    hard ceilings that must hold mid-loop (e.g. a context-budget warning).
 *  - `tool:error` — fires only when the tail message is a `toolResult` with
 *    `isError: true`. The retry_instruction channel: a recovery nudge the model
 *    sees only immediately after a failed tool call.
 */
export type Gate = "turn:start" | "call:every" | "tool:error" | "session:start";

/**
 * The request context handed to a reminder's `content` closure on every
 * evaluation. Read-only; closures must never mutate the array or its members.
 *
 * The messages are the request messages as passed to the `context` event,
 * before reminder insertion; the tail selects the reminder's clock edge and
 * placement. `contextFiles` is only present for `session:start` (durable)
 * evaluation and carries the context files pi loaded for the system prompt
 * (AGENTS.md/CLAUDE.md), so durable content can replay them.
 *
 * The primary consumer is content that depends on the current turn's text
 * (e.g. ranking flow docs against the latest user message). Additive: closures
 * that ignore the context (zero-argument functions) remain valid providers.
 */
export interface ReminderContext {
  /** The request messages as passed to the context event, before insertion. */
  readonly messages: readonly AgentMessage[];
  /** Context files pi loaded (durable/session:start evaluation only). */
  readonly contextFiles?: ReadonlyArray<{ path: string; content: string }>;
}

/**
 * A provider of reminder content. Extensions register these; the manager
 * evaluates them against the message tail on every LLM request and composes
 * the survivors into one transient custom context item adjacent to the tail.
 */
export interface Reminder {
  /** Stable identifier. Re-registering with the same id replaces the prior one. */
  id: string;
  /** Short human label, rendered as the `<reminder type="...">` tag attribute value. */
  label: string;
  /**
   * Encodes the durability contract:
   *
   * - `"transient"` (default) — re-derived on every evaluation and injected as
   *   a wire-only block adjacent to the request tail. Never persisted, never
   *   accumulates. Requires a turn/call/tool gate.
   * - `"durable"` — evaluated at the `session:start` edge (the session's
   *   first user prompt) and PERSISTED into the session as a hidden custom
   *   message (`display: false`) placed immediately before that first user
   *   prompt. The persisted message carries the SAME `<system_reminder>`
   *   envelope the transient channel uses and serializes to a user-role
   *   message on the wire; its inner `<reminder>` tags carry a
   *   `durable="true"` marker. It replays in every subsequent request and on
   *   resume because it is part of the session transcript. Requires
   *   `on: "session:start"`; `contextFiles` is provided at that evaluation.
   *
   *   Use durable for stable, whole-session policy context that must stay in
   *   context for the whole session and across resume, without riding the
   *   system prompt (e.g. AGENTS.md under an RL-parity persona projection).
   */
  lifetime: "transient" | "durable";
  /** Clock edge this reminder fires on. */
  on: Gate;
  /**
   * Lower priority is evicted FIRST when the merged block exceeds the token
   * budget. Default 50. A trigger map should be ~90; a nudge ~60.
   */
  priority?: number;
  /**
   * Re-derived on EVERY evaluation. Return `null` (or empty/whitespace) to skip
   * this call without unregistering. Must be a function: a pre-baked string
   * goes stale by turn two, which is exactly the failure mode this system
   * exists to prevent.
   *
   * Receives the current request message context so content can depend on the
   * turn in progress (e.g. rank against the latest user text). A zero-argument
   * closure remains assignable (TS allows fewer parameters) — existing
   * consumers like pi-memo compile and behave unchanged.
   */
  content: (ctx: ReminderContext) => string | null;
}

/** Agent-layer identity for the transient context item produced by this package. */
export const SYSTEM_REMINDER_CUSTOM_TYPE = "pi-system-reminders";

/** Provenance retained on the agent message but never sent to the provider. */
export interface SystemReminderDetails {
  /** Keeps the real user request last without breaking tool-result adjacency. */
  placement: "before-tail" | "after-tail" | "durable-preamble";
  /** Only reminders that survived priority-based budget eviction. */
  reminderIds: string[];
}
