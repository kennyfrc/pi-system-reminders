/**
 * Durable reminder tests: the persisted delivery contract. Durable content is
 * sent ONCE via pi.sendMessage at the session's first user prompt
 * (before_agent_start), persisted in the session transcript, and replays in
 * every later request and on resume. The persisted block uses the SAME
 * <system_reminder> envelope as transient blocks, serializes to a user-role
 * message, and carries a durable="true" marker on each inner <reminder> tag.
 */
import { describe, expect, it } from "vitest";
import {
  applyReminders,
  getReminders,
  registerReminder,
  renderDurableBlock,
  SYSTEM_REMINDER_CUSTOM_TYPE,
} from "../src/index.js";
import type { Reminder } from "../src/index.js";

interface SentMessage {
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
}

function makeFakePi(session?: { leafId: string | null; entries: Map<string, { parentId?: string | null; type?: string; customType?: string }> }) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: SentMessage[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    sendMessage: async (message: SentMessage) => {
      sent.push(message);
      // Mirrors agent-session.sendCustomMessage at idle with triggerTurn:false:
      // appends to state and persists a custom_message entry parented at the leaf.
      if (session) {
        const id = `e${session.entries.size + 1}`;
        session.entries.set(id, { type: "custom_message", customType: message.customType, parentId: session.leafId });
        session.leafId = id;
      }
    },
  };
  const ctx = session
    ? {
        sessionManager: {
          getLeafId: () => session.leafId,
          getEntry: (id: string) => session.entries.get(id),
        },
      }
    : {};
  return { pi, handlers, sent, ctx, session };
}

function durableReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "agents-md",
    label: "agents-md",
    lifetime: "durable",
    on: "session:start",
    content: (ctx) => (ctx.contextFiles && ctx.contextFiles.length > 0 ? "policy text" : null),
    ...overrides,
  } as Reminder;
}

const FILES = [{ path: "/a/AGENTS.md", content: "# Policy" }];

describe("durable registration validation", () => {
  it("accepts durable + session:start", () => {
    const { pi } = makeFakePi();
    expect(() => registerReminder(pi as never, durableReminder())).not.toThrow();
    expect(getReminders(pi as never)[0]?.lifetime).toBe("durable");
  });

  it("rejects durable on a transient gate", () => {
    const { pi } = makeFakePi();
    expect(() => registerReminder(pi as never, durableReminder({ on: "turn:start" }))).toThrow(/session:start/);
  });

  it("rejects transient on session:start", () => {
    const { pi } = makeFakePi();
    const transient = durableReminder({ lifetime: "transient", on: "session:start" });
    expect(() => registerReminder(pi as never, transient)).toThrow(/lifetime: "durable"/);
  });
});

describe("durable persisted delivery (before_agent_start path)", () => {
  it("persists the block once at the first prompt: same envelope, durable marker, hidden", async () => {
    const { pi, handlers, sent, ctx } = makeFakePi();
    registerReminder(pi as never, durableReminder());
    const before = handlers.get("before_agent_start");
    expect(before).toBeDefined();
    await before?.({ type: "before_agent_start", prompt: "task", systemPromptOptions: { contextFiles: FILES } }, ctx);

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.customType).toBe(SYSTEM_REMINDER_CUSTOM_TYPE);
    expect(msg.display).toBe(false); // hidden in the TUI; still on the wire
    const text = (msg.content as Array<{ type: string; text: string }>)[0].text;
    expect(text.startsWith("<system_reminder>\n")).toBe(true);
    expect(text.trimEnd().endsWith("</system_reminder>")).toBe(true);
    expect(text).toContain('<reminder type="agents-md" durable="true">');
    expect(text).toContain("policy text");
    expect(msg.details).toMatchObject({ placement: "durable-preamble", reminderIds: ["agents-md"] });
  });

  it("does not re-send on the second prompt (entry exists on the branch)", async () => {
    const { pi, handlers, sent, ctx } = makeFakePi({ leafId: null, entries: new Map() });
    registerReminder(pi as never, durableReminder());
    const fire = () =>
      handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: FILES } }, ctx);
    await fire(); // first prompt: sends and persists
    await fire(); // second prompt: entry on branch -> silent
    expect(sent).toHaveLength(1);
  });

  it("does not re-send on resume (persisted entry replays from the transcript)", async () => {
    // A resumed session already carries the durable entry from the previous run.
    const entries = new Map<string, { parentId?: string | null; type?: string; customType?: string }>([
      ["e1", { type: "custom_message", customType: SYSTEM_REMINDER_CUSTOM_TYPE, parentId: null }],
      ["e2", { type: "message", parentId: "e1" }],
    ]);
    const { pi, handlers, sent, ctx } = makeFakePi({ leafId: "e2", entries });
    registerReminder(pi as never, durableReminder());
    await handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: FILES } }, ctx);
    expect(sent).toHaveLength(0);
  });

  it("re-sends once when branched to a point before the block (sibling entry invisible)", async () => {
    // Branch: e1(root) -> e2(custom_message durable)  and  e1 -> e3(leaf, no block).
    const entries = new Map<string, { parentId?: string | null; type?: string; customType?: string }>([
      ["e1", { type: "message", parentId: null }],
      ["e2", { type: "custom_message", customType: SYSTEM_REMINDER_CUSTOM_TYPE, parentId: "e1" }],
      ["e3", { type: "message", parentId: "e1" }],
    ]);
    const { pi, handlers, sent, ctx } = makeFakePi({ leafId: "e3", entries });
    registerReminder(pi as never, durableReminder());
    await handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: FILES } }, ctx);
    expect(sent).toHaveLength(1); // re-derived and sent once on the new branch
  });

  it("skips null content without sending (retry-until-applicable)", async () => {
    const { pi, handlers, sent, ctx } = makeFakePi({ leafId: null, entries: new Map() });
    registerReminder(pi as never, durableReminder());
    // No contextFiles captured yet -> content returns null -> nothing sent.
    await handlers.get("before_agent_start")?.({ systemPromptOptions: {} }, ctx);
    expect(sent).toHaveLength(0);
    // Files arrive with the prompt -> sends.
    await handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: FILES } }, ctx);
    expect(sent).toHaveLength(1);
  });

  it("falls back to an in-memory sent-guard without a sessionManager", async () => {
    const { pi, handlers, sent, ctx } = makeFakePi();
    registerReminder(pi as never, durableReminder());
    const fire = () => handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: FILES } }, ctx);
    await fire();
    await fire();
    expect(sent).toHaveLength(1);
    // A new session on the same instance re-arms delivery.
    await handlers.get("session_start")?.({}, {});
    await fire();
    expect(sent).toHaveLength(2);
  });
});

describe("durable + wire shape", () => {
  it("context path never injects durable content (no double delivery)", () => {
    const USER = { role: "user", content: [{ type: "text", text: "task" }] } as never;
    const out = applyReminders([USER], [durableReminder()]);
    expect(out).toHaveLength(1); // same array, nothing inserted
  });

  it("renderDurableBlock joins multiple sections, each marked durable", () => {
    const reminders = [
      durableReminder(),
      durableReminder({ id: "tool-search", label: "tool-search", content: () => "nudge" }),
    ];
    const block = renderDurableBlock(reminders, FILES);
    expect(block).not.toBeNull();
    expect(block!.text).toContain('<reminder type="agents-md" durable="true">');
    expect(block!.text).toContain('<reminder type="tool-search" durable="true">');
    expect(block!.reminderIds).toEqual(["agents-md", "tool-search"]);
    // Transient reminders are never part of the durable block.
    const withTransient = [
      ...reminders,
      durableReminder({ id: "t", label: "t", lifetime: "transient", on: "turn:start", content: () => "x" }),
    ];
    expect(renderDurableBlock(withTransient, FILES)!.text).not.toContain('type="t"');
  });

  it("the persisted block serializes to a USER-role message on the wire", async () => {
    // The real convertToLlm from pi-agent-core: custom -> user.
    const { convertToLlm } = await import("@earendil-works/pi-agent-core");
    const block = renderDurableBlock([durableReminder()], FILES)!;
    const persisted = {
      role: "custom",
      customType: SYSTEM_REMINDER_CUSTOM_TYPE,
      content: [{ type: "text", text: block.text }],
      display: false,
      details: { placement: "durable-preamble", reminderIds: block.reminderIds },
      timestamp: Date.now(),
    } as never;
    const wire = convertToLlm([persisted]);
    expect(wire).toHaveLength(1);
    expect(wire[0].role).toBe("user");
    expect((wire[0].content as Array<{ type: string; text: string }>)[0].text).toContain(
      '<reminder type="agents-md" durable="true">',
    );
  });
});
