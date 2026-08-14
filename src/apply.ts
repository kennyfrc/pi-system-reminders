/**
 * Pure reminder evaluation and composition. No Pi imports of live state here —
 * this module is exercised by the test suite with plain message arrays.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Gate, Reminder, SystemReminderDetails } from "./types.js";
import { SYSTEM_REMINDER_CUSTOM_TYPE } from "./types.js";

/** Default merged-block budget in characters (~2000 tokens at 4 chars/token). */
export const DEFAULT_BUDGET_CHARS = 8000;

export const DEFAULT_PRIORITY = 50;

interface ReminderSection {
  label: string;
  text: string;
  priority: number;
}

interface FiredReminder extends ReminderSection {
  id: string;
}

/**
 * `role` is read dynamically because `AgentMessage` is a wide union
 * (`Message | CustomAgentMessages[...]`). We never need to fully narrow — only
 * inspect two fields of the tail, so dynamic access is both simpler and honest
 * about the runtime contract.
 */
function roleOf(m: AgentMessage): string {
  return (m as { role?: string }).role ?? "";
}

function isToolResultError(m: AgentMessage): boolean {
  return roleOf(m) === "toolResult" && (m as { isError?: boolean }).isError === true;
}

/**
 * Does `gate` fire given the tail of the (cloned) message array?
 *
 * - `turn:start`: tail is a plain user message (first LLM call of a user turn).
 *   After the first call, tool results/assistant messages are appended, so the
 *   tail is no longer a bare user message → does not fire. Steering/follow-up
 *   user messages count as a new turn (correct: they reset the transient block).
 * - `tool:error`: tail is a tool result marked `isError: true`.
 * - `call:every`: any non-empty tail.
 */
export function gateMatches(gate: Gate, messages: AgentMessage[]): boolean {
  if (messages.length === 0) return false;
  if (gate === "call:every") return true;
  const tail = messages[messages.length - 1];
  switch (gate) {
    case "turn:start":
      return roleOf(tail) === "user";
    case "tool:error":
      return isToolResultError(tail);
  }
}

/**
 * Compose the reminder block from fired reminders, evicting by priority
 * (lowest first) until under `budgetChars`. Returns `null` if nothing survives.
 */
export function composeBlock(fired: ReminderSection[], budgetChars: number): string | null {
  const kept = selectRemindersWithinBudget(fired, budgetChars);
  return kept === null ? null : renderBlock(kept);
}

function selectRemindersWithinBudget<T extends ReminderSection>(fired: T[], budgetChars: number): T[] | null {
  if (fired.length === 0) return null;
  // High priority first; lowest-priority ends up at the tail and is sliced off.
  const kept = [...fired].sort((a, b) => b.priority - a.priority);
  const totalChars = (arr: ReminderSection[]) => arr.reduce((n, r) => n + r.text.length, 0);
  while (kept.length > 0 && totalChars(kept) > budgetChars) {
    kept.length = kept.length - 1; // drop lowest priority
  }
  if (kept.length === 0) return null;
  return kept;
}

function renderBlock(kept: ReminderSection[]): string {
  const sections = kept
    .map((r) => `<reminder type="${r.label}">\n${r.text}\n</reminder>`)
    .join("\n");
  // Single singular outer envelope wrapping the whole reminder block. Each
  // inner <reminder> tag carries the reminder's label under a `type` attribute.
  // The <system_reminder> wrapper itself carries no attributes. Matches the
  // singular tag the static-compactor strips (open + close on their own lines).
  return `<system_reminder>\n${sections}\n</system_reminder>`;
}

/**
 * The core transform. Given the (already-cloned) request messages and the
 * registered reminders, return either a new message array with the reminder
 * block inserted as a distinct custom item, OR the SAME array reference if nothing
 * fired (so the caller can short-circuit and report "no change" cheaply).
 *
 * Human-authored messages are never rewritten. Provider-specific role
 * normalization belongs downstream in `convertToLlm` and provider adapters;
 * this layer preserves agent-message identity and reminder provenance. When
 * the tail is a user message, the reminder is inserted immediately BEFORE it
 * so the actual request remains the provider's final human text entry. Tool
 * results stay ahead of an appended reminder so tool-call/result adjacency is
 * never interrupted.
 */
export function applyReminders(
  messages: AgentMessage[],
  reminders: Reminder[],
  budgetChars: number = DEFAULT_BUDGET_CHARS,
): AgentMessage[] {
  if (reminders.length === 0) return messages;

  const fired: FiredReminder[] = [];
  for (const r of reminders) {
    if (!gateMatches(r.on, messages)) continue;
    let text: string | null = null;
    try {
      // The messages context ships the current turn's text so content can rank
      // against the latest user message (e.g. pi-flows' ranked trigger map).
      // Zero-arg closures ignore it and keep working (additive interface).
      text = r.content({ messages });
    } catch {
      // A throwing provider is skipped, never breaks a request.
      continue;
    }
    if (text == null || text.trim() === "") continue;
    fired.push({ id: r.id, label: r.label, text, priority: r.priority ?? DEFAULT_PRIORITY });
  }

  const kept = selectRemindersWithinBudget(fired, budgetChars);
  if (kept === null) return messages; // no-op: same reference signals unchanged

  const out = messages.slice();
  const placement: SystemReminderDetails["placement"] =
    roleOf(messages[messages.length - 1]) === "user" ? "before-tail" : "after-tail";
  const details: SystemReminderDetails = {
    lifetime: "transient",
    placement,
    reminderIds: kept.map((r) => r.id),
  };
  const reminderMessage = {
    role: "custom",
    customType: SYSTEM_REMINDER_CUSTOM_TYPE,
    content: [{ type: "text", text: renderBlock(kept) }],
    display: false,
    details,
    timestamp: Date.now(),
  } as AgentMessage;
  if (placement === "before-tail") {
    out.splice(out.length - 1, 0, reminderMessage);
  } else {
    out.push(reminderMessage);
  }
  return out;
}
