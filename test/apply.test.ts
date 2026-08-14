import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyReminders, composeBlock, gateMatches } from "../src/apply.js";
import type { Reminder } from "../src/types.js";

// --- message fixtures -------------------------------------------------------

const user = (content: string | { type: "text"; text: string }[], timestamp = 1): Message => ({
  role: "user",
  content,
  timestamp,
});

const toolResult = (opts: { isError?: boolean; timestamp?: number } = {}): Message => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "t",
  content: [{ type: "text", text: "r" }],
  isError: opts.isError ?? false,
  timestamp: opts.timestamp ?? 2,
});

const assistant = (timestamp = 3): Message => ({
  role: "assistant",
  content: [{ type: "text", text: "a" }],
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});

const reminder = (over: Partial<Reminder> & Pick<Reminder, "id" | "on">): Reminder => ({
  label: over.id,
  lifetime: "transient",
  content: () => "BODY",
  ...over,
});

// --- gateMatches ------------------------------------------------------------

describe("gateMatches", () => {
  it("turn:start fires only when tail is a plain user message", () => {
    expect(gateMatches("turn:start", [user("hi")])).toBe(true);
    expect(gateMatches("turn:start", [user("hi"), assistant(), toolResult()])).toBe(false);
    expect(gateMatches("turn:start", [user("hi"), assistant()])).toBe(false);
  });

  it("turn:start does not fire on empty messages", () => {
    expect(gateMatches("turn:start", [])).toBe(false);
  });

  it("tool:error fires only when tail is an errored tool result", () => {
    expect(gateMatches("tool:error", [user("hi"), assistant(), toolResult({ isError: true })])).toBe(true);
    expect(gateMatches("tool:error", [user("hi"), assistant(), toolResult({ isError: false })])).toBe(false);
    expect(gateMatches("tool:error", [user("hi")])).toBe(false);
  });

  it("call:every fires on any non-empty tail", () => {
    expect(gateMatches("call:every", [user("hi")])).toBe(true);
    expect(gateMatches("call:every", [toolResult()])).toBe(true);
    expect(gateMatches("call:every", [])).toBe(false);
  });
});

// --- composeBlock (budget eviction) -----------------------------------------

describe("composeBlock", () => {
  it("returns null when nothing fired", () => {
    expect(composeBlock([], 8000)).toBeNull();
  });

  it("wraps reminders in a singular <system_reminder> envelope with inner <reminder type> tags", () => {
    const out = composeBlock([{ label: "flows", text: "MAP", priority: 90 }], 8000)!;
    expect(out).toContain("<system_reminder>");
    expect(out).toContain('<reminder type="flows">');
    expect(out).toContain("MAP");
    expect(out).toContain("</reminder>");
    expect(out).toContain("</system_reminder>");
    // No plural envelope; wrapper carries no attributes.
    expect(out).not.toContain("<system_reminders>");
    expect(out).not.toContain('<system_reminder ');
  });

  it("evicts lowest-priority sections first under budget pressure", () => {
    const out = composeBlock(
      [
        { label: "nudge", text: "x".repeat(100), priority: 30 },
        { label: "flows", text: "y".repeat(100), priority: 90 },
      ],
      150, // fits one ~100-char section but not both
    )!;
    expect(out).toContain("flows");
    expect(out).not.toContain("nudge");
  });

  it("returns null when even the highest-priority section busts the budget", () => {
    expect(composeBlock([{ label: "big", text: "x".repeat(1000), priority: 90 }], 100)).toBeNull();
  });
});

// --- applyReminders (integration) -------------------------------------------

describe("applyReminders", () => {
  it("is a no-op (same reference) when no reminders are registered", () => {
    const msgs: AgentMessage[] = [user("hi")];
    expect(applyReminders(msgs, [])).toBe(msgs);
  });

  it("is a no-op (same reference) when a reminder's gate does not match", () => {
    const msgs: AgentMessage[] = [user("hi"), assistant(), toolResult()]; // tail is toolResult
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });
    expect(applyReminders(msgs, [r])).toBe(msgs);
  });

  it("is a no-op (same reference) when content() returns null", () => {
    const msgs: AgentMessage[] = [user("hi")];
    const r = reminder({ id: "flows", on: "turn:start", content: () => null });
    expect(applyReminders(msgs, [r])).toBe(msgs);
  });

  it("passes { messages } into content changes (1 argument)", () => {
    const msgs: AgentMessage[] = [user("hello there")];
    let capturedLength = -1;
    let capturedRole = "";
    const r = reminder({
      id: "flows",
      on: "turn:start",
      content: (ctx) => {
        capturedLength = ctx.messages.length;
        const tail = ctx.messages[ctx.messages.length - 1] as { role?: string } | undefined;
        capturedRole = tail?.role ?? "";
        return "MAP";
      },
    });
    applyReminders(msgs, [r]);
    expect(capturedLength).toBe(1);
    expect(capturedRole).toBe("user");
  });

  it("keeps a zero-argument content closure assignable and working (additive interface)", () => {
    const msgs: AgentMessage[] = [user("hi")];
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });
    const out = applyReminders(msgs, [r]);
    expect(out).not.toBe(msgs);
    expect(JSON.stringify(out[0])).toContain("MAP");
  });

  it("is a no-op (same reference) when content() throws", () => {
    const msgs: AgentMessage[] = [user("hi")];
    const r = reminder({ id: "boom", on: "turn:start", content: () => {
      throw new Error("provider exploded");
    } });
    expect(applyReminders(msgs, [r])).toBe(msgs);
  });

  it("preserves the human message as the final item and inserts a separate transient reminder before it", () => {
    const human = user("hi", 42);
    const msgs: AgentMessage[] = [human];
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });

    const out = applyReminders(msgs, [r]);

    expect(out).not.toBe(msgs);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(human);
    expect(out[0]).toMatchObject({
      role: "custom",
      customType: "pi-system-reminders",
      display: false,
      details: {
        lifetime: "transient",
        placement: "before-tail",
        reminderIds: ["flows"],
      },
    });
  });

  it("keeps a trailing string-content user message unchanged (turn:start)", () => {
    const human = user("hi");
    const msgs: AgentMessage[] = [human];
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });
    const out = applyReminders(msgs, [r]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(human);
    expect(out[1]).toEqual(user("hi"));
    expect(JSON.stringify(out[0])).toContain("MAP");
  });

  it("keeps a trailing array-content user message unchanged (turn:start)", () => {
    const human = user([{ type: "text", text: "hi" }]);
    const msgs: AgentMessage[] = [human];
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });
    const out = applyReminders(msgs, [r]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(human);
    expect(out[1]).toEqual(user([{ type: "text", text: "hi" }]));
    expect(JSON.stringify(out[0])).toContain("MAP");
  });

  it("appends a fresh custom item when the tail is a toolResult (call:every)", () => {
    const msgs: AgentMessage[] = [user("hi"), assistant(), toolResult()];
    const r = reminder({ id: "ceil", on: "call:every", content: () => "CEILING" });
    const out = applyReminders(msgs, [r]);
    expect(out).not.toBe(msgs);
    expect(out).toHaveLength(msgs.length + 1);
    const appended = out[out.length - 1] as { role: string; customType?: string; content: unknown };
    expect(appended.role).toBe("custom");
    expect(appended.customType).toBe("pi-system-reminders");
    expect(JSON.stringify(appended.content)).toContain("CEILING");
    expect((appended as { details?: { placement?: string } }).details?.placement).toBe("after-tail");
    // Original array untouched.
    expect(msgs).toHaveLength(3);
  });

  it("appends a retry nudge on tool:error", () => {
    const msgs: AgentMessage[] = [user("hi"), assistant(), toolResult({ isError: true })];
    const r = reminder({ id: "recover", on: "tool:error", content: () => "RETRY" });
    const out = applyReminders(msgs, [r]);
    expect(out).toHaveLength(msgs.length + 1);
    const appended = out[out.length - 1] as { role: string; customType?: string };
    expect(appended.role).toBe("custom");
    expect(appended.customType).toBe("pi-system-reminders");
  });

  it("wraps multiple fired reminders in one singular <system_reminder> envelope with typed <reminder> sections", () => {
    const msgs: AgentMessage[] = [user("hi")];
    const flows = reminder({ id: "flows", label: "flows", on: "turn:start", priority: 90, content: () => "MAP" });
    const todo = reminder({ id: "todo", label: "todo", on: "turn:start", priority: 60, content: () => "PLAN" });
    const out = applyReminders(msgs, [flows, todo]);
    const appended = out[0] as {
      content: Array<{ type: string; text?: string }>;
      details?: { reminderIds?: string[] };
    };
    const text = appended.content.find((block) => block.type === "text")?.text ?? "";
    // One singular outer envelope; both reminders live as inner <reminder> tags.
    expect(text).toContain("<system_reminder>");
    expect(text).toContain("</system_reminder>");
    expect(text).toContain('<reminder type="flows">');
    expect(text).toContain('<reminder type="todo">');
    expect(text).toContain("MAP");
    expect(text).toContain("PLAN");
    // Exactly one outer wrapper opens and closes; no plural form; wrapper has no attributes.
    expect(text.match(/<system_reminder>/g)).toHaveLength(1);
    expect(text.match(/<\/system_reminder>/g)).toHaveLength(1);
    expect(text).not.toContain("<system_reminders>");
    expect(text).not.toContain('<system_reminder ');
    expect(appended.details?.reminderIds).toEqual(["flows", "todo"]);
  });

  it("does not mutate the input message objects", () => {
    const original = [user("hi")];
    const snapshot = JSON.stringify(original);
    const r = reminder({ id: "flows", on: "turn:start", content: () => "MAP" });
    applyReminders(original, [r]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
