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
 * See devdocs/designs/pi-system-reminders.html for the full design.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * A clock edge — the moment within the agent loop at which a reminder may fire.
 *
 * The four clocks: session → turn → call → tool. Edges pick the firing points:
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
export type Gate = "turn:start" | "call:every" | "tool:error";

/**
 * The request context handed to a reminder's `content` closure on every
 * evaluation. Read-only; closures must never mutate the array or its members.
 *
 * The messages are the request messages as passed to the `context` event,
 * before reminder insertion; the tail selects the reminder's clock edge and
 * placement.
 * The primary consumer is content that depends on the current turn's text
 * (e.g. ranking flow docs against the latest user message). Additive: closures
 * that ignore the context (zero-argument functions) remain valid providers.
 */
export interface ReminderContext {
  /** The request messages as passed to the context event, before insertion. */
  readonly messages: readonly AgentMessage[];
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
   * Encodes the durability contract. ONLY `"transient"` is supported.
   *
   * `"durable"` is deliberately rejected at registration: durable content
   * (instrumentation, tool call results, anything that cannot be re-derived)
   * must NOT ride this ephemeral channel — it belongs in real session messages
   * or the `before_agent_start` hook. Rejecting it here is the teaching guard
   * that keeps the system from silently regressing into history accumulation.
   */
  lifetime: "transient";
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
  lifetime: "transient";
  /** Keeps the real user request last without breaking tool-result adjacency. */
  placement: "before-tail" | "after-tail";
  /** Only reminders that survived priority-based budget eviction. */
  reminderIds: string[];
}
