import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  EventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyReminders } from "../src/apply.js";
import type { Reminder } from "../src/types.js";

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1024,
};

const reminder: Reminder = {
  id: "flows",
  label: "flows",
  lifetime: "transient",
  on: "turn:start",
  content: () => "MAP",
};

class MockAssistantStream extends EventStream<
  | { type: "done"; reason: "stop"; message: AssistantMessage }
  | { type: "error"; reason: "error"; error: AssistantMessage },
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => (event.type === "done" ? event.message : event.error),
    );
  }
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

describe("transient reminder lifecycle", () => {
  it("is provider-visible without entering the agent transcript or persistence event stream", async () => {
    let providerContext: Context | undefined;
    const persistedRoles: string[] = [];
    const agent = new Agent({
      initialState: { model, systemPrompt: "system", tools: [] },
      getApiKey: () => "test-key",
      transformContext: async (messages) => applyReminders(messages, [reminder]),
      convertToLlm,
      streamFn: (_model, context) => {
        providerContext = context;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const message = assistantMessage("done");
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });
    agent.subscribe((event) => {
      // AgentSession persists only message_end events. Context transforms do not
      // emit one, so this is the persistence boundary used by the real session.
      if (event.type === "message_end") persistedRoles.push(event.message.role);
    });

    await agent.prompt("hello world");

    expect(providerContext?.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(providerContext?.messages[0]?.content)).toContain("<system_reminder>");
    expect(JSON.stringify(providerContext?.messages[1]?.content)).toContain("hello world");

    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(agent.state.messages.some((message: AgentMessage) => message.role === "custom")).toBe(false);
    expect(persistedRoles).toEqual(["user", "assistant"]);
  });
});
