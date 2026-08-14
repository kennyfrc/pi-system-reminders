/**
 * Extension-facing API. Self-installing: the FIRST caller of `registerReminder`
 * with a given `pi` also installs the single `context` event handler for that
 * instance (idempotent). Clients just depend on this package and call
 * `registerReminder` from their own default export — no need to list
 * pi-system-reminders as a separate extension in settings.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyReminders } from "./apply.js";
import type { Reminder } from "./types.js";

export type { Gate, Reminder, ReminderContext, SystemReminderDetails } from "./types.js";
export { SYSTEM_REMINDER_CUSTOM_TYPE } from "./types.js";
export { applyReminders, composeBlock, gateMatches, DEFAULT_BUDGET_CHARS } from "./apply.js";

/**
 * Per-`pi` reminder registries. Keyed by the ExtensionAPI instance so multiple
 * logical agents (if ever present) don't cross-contaminate, and so the registry
 * is garbage-collected with the instance.
 */
const stores = new WeakMap<ExtensionAPI, Reminder[]>();
const installed = new WeakSet<ExtensionAPI>();

/**
 * Register (or replace, by `id`) a transient reminder on `pi`. Idempotently
 * installs the context handler bound to this `pi` on first registration.
 */
export function registerReminder(pi: ExtensionAPI, reminder: Reminder): void {
  if ((reminder as { lifetime?: string }).lifetime === "durable") {
    throw new Error(
      `pi-system-reminders: reminder "${reminder.id}" declared lifetime "durable". ` +
        `Durable content cannot ride the ephemeral context channel — use the ` +
        `\`before_agent_start\` event (return messages) or persistent session entries instead.`,
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
    pi.on("context", (event) => {
      const reminders = stores.get(pi);
      if (!reminders || reminders.length === 0) return undefined;
      const next = applyReminders(event.messages, reminders);
      // Same reference => nothing fired => no-op (avoids needless array churn).
      return next === event.messages ? undefined : { messages: next };
    });
  }
}

/** Test/diagnostics helper: read the registered reminders for a `pi`. */
export function getReminders(pi: ExtensionAPI): readonly Reminder[] {
  return stores.get(pi) ?? [];
}
