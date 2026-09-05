import type { ModelSlot } from "../shared/model.ts";
import type { TextModel } from "./ports.ts";

/**
 * Why a call failed, in terms the UI can act on: "auth" means fix your key,
 * "rate_limit" and "server" mean the provider is having a moment, "bad_request"
 * usually means the model name is wrong.
 */
export type ModelErrorReason =
  "auth" | "rate_limit" | "server" | "network" | "bad_request" | "bad_response";

export class ModelError extends Error {
  readonly reason: ModelErrorReason;

  constructor(reason: ModelErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelError";
    this.reason = reason;
  }
}

const RETRYABLE = new Set<ModelErrorReason>(["rate_limit", "server", "network"]);

interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface TextModelOptions {
  slot: ModelSlot;
  /** Injected so tests need no network and no key. */
  fetch?: typeof globalThis.fetch;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** First backoff step; doubles each retry. Default 500ms. */
  baseDelayMs?: number;
}

/**
 * The configured Text Model slot, spoken to over the OpenAI-compatible
 * `/chat/completions` shape (ADR 0002).
 *
 * Deliberately does not send `response_format: json_object`: plenty of
 * OpenAI-compatible providers reject the field, and supporting all of them through
 * one code path is the entire point of that ADR. `completeJson` earns the same
 * result by parsing tolerantly and repairing once.
 */
export function createTextModel(options: TextModelOptions): TextModel {
  const { slot } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/chat/completions`;

  async function callOnce(messages: Message[]): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${slot.apiKey}`,
        },
        body: JSON.stringify({ model: slot.model, messages }),
      });
    } catch (cause) {
      throw new ModelError("network", `Could not reach ${endpoint}`, { cause });
    }

    if (!response.ok) {
      throw new ModelError(
        statusToReason(response.status),
        `Model call failed with ${response.status}: ${(await safeText(response)).slice(0, 500)}`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ModelError("bad_response", "Model returned no message content");
    }
    return content;
  }

  async function call(messages: Message[]): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce(messages);
      } catch (error) {
        const retryable = error instanceof ModelError && RETRYABLE.has(error.reason);
        if (!retryable || attempt >= attempts) throw error;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  return {
    complete(prompt: string): Promise<string> {
      return call([{ role: "user", content: prompt }]);
    },

    async completeJson<T>(prompt: string): Promise<T> {
      const messages: Message[] = [{ role: "user", content: prompt }];
      const first = await call(messages);

      const parsed = tryParse<T>(first);
      if (parsed.ok) return parsed.value;

      // One repair round-trip. Models wrap JSON in prose or fences often enough to
      // be worth handling, and rarely enough that a second failure means something
      // is actually wrong rather than needing a third try.
      const repaired = await call([
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content:
            "That was not valid JSON. Reply with only the JSON value, no prose, no code fences.",
        },
      ]);

      const retried = tryParse<T>(repaired);
      if (retried.ok) return retried.value;
      throw new ModelError(
        "bad_response",
        `Model did not return JSON, even after a repair attempt: ${repaired.slice(0, 200)}`,
      );
    },
  };
}

/** Accepts bare JSON, a fenced block, or JSON sitting inside a sentence. */
function tryParse<T>(raw: string): { ok: true; value: T } | { ok: false } {
  for (const candidate of [raw, ...extractCandidates(raw)]) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T };
    } catch {
      // try the next shape
    }
  }
  return { ok: false };
}

function extractCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // Ordered by which bracket opens first, because that is the outermost structure.
  // Trying `{` first would pull the first object out of an array and silently
  // return it instead of the list.
  const spans = (
    [
      ["{", "}"],
      ["[", "]"],
    ] as const
  )
    .map(([open, close]) => ({ start: raw.indexOf(open), end: raw.lastIndexOf(close) }))
    .filter((span) => span.start !== -1 && span.end > span.start)
    .sort((left, right) => left.start - right.start);

  for (const span of spans) candidates.push(raw.slice(span.start, span.end + 1));
  return candidates;
}

function statusToReason(status: number): ModelErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
