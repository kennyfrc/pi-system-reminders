# pi-system-reminders

System reminders for Pi: steer agents with contextual nudges during long
agentic flows.

Two durability contracts, one state machine on the `context` event:

- **Transient** — re-derived on every evaluation and injected adjacent to the
  request tail as one `<system_reminder>` block, then discarded. Never
  persisted, never accumulate in history. Clock edges: `turn:start` (fires
  every turn), `call:every` (fires after every tool call), `tool:error`
  (fires when the last tool result is an error).
- **Durable** — evaluated once per session and delivered at the session's
  first user prompt (gate: no assistant/tool messages yet, so resumes and
  context-carrying first prompts stay clean). Content survives the session
  in the message history; exempt from the transient eviction budget.

```ts
import { registerReminder } from "@kennyfrc/pi-system-reminders";

registerReminder(pi, {
  id: "flows",
  label: "flows",
  lifetime: "transient",
  on: "turn:start",
  content: () => "Use the flows tool before committing to a procedure.",
});

registerReminder(pi, {
  id: "context-files",
  label: "context-files",
  lifetime: "durable",
  on: "session:start",
  content: ({ messages }) => (messages.length > 0 ? "..." : null),
});
```

`content` may return `null` to defer (retry-until-applicable); text is
trimmed and deduped. Reminder blocks land before the tail as user-role
content with a `system_reminder` envelope; the envelope is dropped before
the payload reaches the provider, so the model sees the reminder while the
history stays clean.

## Install

```sh
pi install npm:@kennyfrc/pi-system-reminders
```

Or reference the local path in `settings.json`. The package self-installs on
the first `registerReminder` call; no manual wiring.

## Tests

```sh
npm test
```

## Quick start

```bash
pi install npm:@kennyfrc/pi-system-reminders
```

That writes the package into `~/.pi/agent/settings.json` and resolves its
dependencies automatically. Try it once without installing:

```bash
pi -e npm:@kennyfrc/pi-system-reminders
```

Or register it by hand in `~/.pi/agent/settings.json`:

```json
{ "packages": ["@kennyfrc/pi-system-reminders"] }
```

Restart pi (or start a new session) to load it.
