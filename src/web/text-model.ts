import type { ModelSlot } from "../shared/model.ts";

/**
 * The configured Text Model slot. Shared by the Annotator (translation) and the
 * ask-AI popup — which is what earns it its own seam: delete it and auth, retry,
 * error normalisation and JSON repair get written twice.
 */
export interface TextModel {
  complete(prompt: string): Promise<string>;
  /** Retries once with a repair prompt when the model returns unparseable JSON. */
  completeJson<T>(prompt: string): Promise<T>;
  /**
   * Yields the answer as the model generates it, for the ask-AI popup. Unlike
   * `complete`, a failure is not retried: retrying after some of the answer has
   * already reached the caller would mean showing a second answer underneath the
   * first, which is worse than just stopping.
   */
  completeStream(prompt: string): AsyncIterable<string>;
}

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

/**
 * A rate limit is deliberately not one of them. The retries come half a second and a
 * second later, and a limit counted per minute refuses those the same way: each attempt
 * spends more of an allowance that has just run out, and one translation window went out
 * three times on its way to failing.
 */
const RETRYABLE = new Set<ModelErrorReason>(["server", "network"]);

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

  async function* streamOnce(messages: Message[]): AsyncIterable<string> {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${slot.apiKey}`,
        },
        body: JSON.stringify({ model: slot.model, messages, stream: true }),
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
    if (!response.body) return;

    // SSE lines are not guaranteed to land on chunk boundaries, so a partial line at
    // the end of one read is held back and glued to the front of the next.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield* deltaOf(line);
    }
  }

  function* deltaOf(line: string): Generator<string> {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      // A provider that puts a comment or keep-alive on the wire is not an error.
    }
  }

  return {
    complete(prompt: string): Promise<string> {
      return call([{ role: "user", content: prompt }]);
    },

    completeStream(prompt: string): AsyncIterable<string> {
      return streamOnce([{ role: "user", content: prompt }]);
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

/**
 * Lists the models available at a slot's base URL — the OpenAI-compatible
 * `GET /models` shape, which every provider from ADR 0002 exposes regardless of
 * whether the slot ends up used for chat or transcription. Feeds the Settings
 * screen's model picker, so a model name does not have to be typed from memory or
 * copied out of a provider's docs.
 */
export async function listModels(
  slot: ModelSlot,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  if (!slot.baseUrl.trim()) {
    throw new ModelError("bad_request", "Set a base URL first.");
  }
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/models`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${slot.apiKey}` },
    });
  } catch (cause) {
    throw new ModelError("network", `Could not reach ${endpoint}`, { cause });
  }

  if (!response.ok) {
    throw new ModelError(
      statusToReason(response.status),
      `Listing models failed with ${response.status}: ${(await safeText(response)).slice(0, 500)}`,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    data?: { id?: unknown }[];
  } | null;
  const ids = body?.data
    ?.map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string");
  if (!ids) throw new ModelError("bad_response", "Model list returned no data array");

  return ids.sort();
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
