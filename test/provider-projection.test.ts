import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyReminders } from "../src/apply.js";
import type { Reminder } from "../src/types.js";

function fixtureModel<TApi extends Api>(api: TApi): Model<TApi> {
  return {
    id: "fixture",
    name: "Fixture",
    api,
    provider: "fixture",
    baseUrl: "http://127.0.0.1:9",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  } as Model<TApi>;
}

function reminderContext(): Context {
  const human = { role: "user", content: "hello world", timestamp: 1 };
  const reminder: Reminder = {
    id: "flows",
    label: "flows",
    lifetime: "transient",
    on: "turn:start",
    content: () => "MAP",
  };
  const agentMessages = applyReminders([human] as AgentMessage[], [reminder]);
  return { systemPrompt: "system", messages: convertToLlm(agentMessages) };
}

async function capturePayload<TApi extends Api>(
  api: TApi,
  streamFn: StreamFunction<TApi, SimpleStreamOptions>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const stream = streamFn(fixtureModel(api), reminderContext(), {
    apiKey: "test",
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>;
      throw new Error("payload captured");
    },
  });
  await stream.result();
  if (!captured) throw new Error(`Expected ${api} payload before request dispatch`);
  return captured;
}

function userTexts(payload: Record<string, unknown>): string[] {
  const items = (payload.messages ?? payload.input) as Array<{ role?: string; content?: unknown }>;
  return items
    .filter((item) => item.role === "user")
    .map((item) => {
      if (typeof item.content === "string") return item.content;
      if (!Array.isArray(item.content)) return "";
      return item.content
        .map((part) => {
          if (typeof part !== "object" || part === null) return "";
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .join("");
    });
}

function expectSeparateHumanAndReminder(payload: Record<string, unknown>): void {
  const texts = userTexts(payload);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain("<system_reminder>");
  expect(texts[0]).toContain("MAP");
  expect(texts[1]).toBe("hello world");
}

describe("provider projection preserves the reminder message boundary", () => {
  it("serializes separate entries for OpenAI Chat Completions", async () => {
    expectSeparateHumanAndReminder(await capturePayload("openai-completions", streamOpenAICompletions));
  });

  it("serializes separate entries for OpenAI Responses", async () => {
    expectSeparateHumanAndReminder(await capturePayload("openai-responses", streamOpenAIResponses));
  });

  it("serializes separate entries for Anthropic Messages", async () => {
    expectSeparateHumanAndReminder(await capturePayload("anthropic-messages", streamAnthropicMessages));
  });
});
