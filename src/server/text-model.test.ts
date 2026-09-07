import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelSlot } from "../shared/model.ts";
import { ModelError, createTextModel, listModels } from "./text-model.ts";

const slot: ModelSlot = {
  baseUrl: "https://api.example.com/v1/",
  apiKey: "sk-test",
  model: "some-model",
};

type Outcome = Response | Error;

/** Replays outcomes in order; the last one repeats once the list runs out. */
function stubFetch(...outcomes: Outcome[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const outcome = outcomes[Math.min(index++, outcomes.length - 1)] as Outcome;
    if (outcome instanceof Error) throw outcome;
    return outcome.clone();
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(fetch, { calls });
}

const says = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

const fails = (status: number) => new Response("upstream said no", { status });

/** One Response whose body arrives as these separate chunks — a real SSE reply can
    split a line across chunk boundaries, which a body built from one string cannot
    exercise. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const model = (fetch: typeof globalThis.fetch) =>
  createTextModel({ slot, fetch, baseDelayMs: 0 });

describe("text model", () => {
  it("posts the prompt to the OpenAI-compatible chat endpoint", async () => {
    const fetch = stubFetch(says("こんにちは"));
    const answer = await model(fetch).complete("请帮我理解 今日は自己紹介をします");

    assert.equal(answer, "こんにちは");
    assert.equal(fetch.calls[0]?.url, "https://api.example.com/v1/chat/completions");
    assert.deepEqual(fetch.calls[0]?.body, {
      model: "some-model",
      messages: [{ role: "user", content: "请帮我理解 今日は自己紹介をします" }],
    });
  });

  it("retries a rate limit, then a server error, and succeeds", async () => {
    const fetch = stubFetch(fails(429), says("finally"));
    assert.equal(await model(fetch).complete("hi"), "finally");
    assert.equal(fetch.calls.length, 2);

    const flaky = stubFetch(fails(503), says("finally"));
    assert.equal(await model(flaky).complete("hi"), "finally");
  });

  it("retries a network failure", async () => {
    const fetch = stubFetch(new TypeError("connection refused"), says("recovered"));
    assert.equal(await model(fetch).complete("hi"), "recovered");
    assert.equal(fetch.calls.length, 2);
  });

  it("gives up after the attempt budget, keeping the reason", async () => {
    const fetch = stubFetch(fails(500));
    await assert.rejects(model(fetch).complete("hi"), (error: ModelError) => {
      assert.equal(error.reason, "server");
      return true;
    });
    assert.equal(fetch.calls.length, 3);
  });

  it("does not retry a bad key — that will never fix itself", async () => {
    const fetch = stubFetch(fails(401));
    await assert.rejects(model(fetch).complete("hi"), (error: ModelError) => {
      assert.equal(error.reason, "auth");
      return true;
    });
    assert.equal(fetch.calls.length, 1);
  });

  it("does not retry a rejected request", async () => {
    const fetch = stubFetch(fails(400));
    await assert.rejects(model(fetch).complete("hi"), (error: ModelError) => {
      assert.equal(error.reason, "bad_request");
      return true;
    });
    assert.equal(fetch.calls.length, 1);
  });

  it("treats a response with no content as a bad response", async () => {
    const fetch = stubFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await assert.rejects(model(fetch).complete("hi"), (error: ModelError) => {
      assert.equal(error.reason, "bad_response");
      return true;
    });
  });

  describe("completeJson", () => {
    it("parses a plain JSON reply", async () => {
      const fetch = stubFetch(says('{"translation":"你好"}'));
      assert.deepEqual(await model(fetch).completeJson("translate"), { translation: "你好" });
    });

    it("unwraps a fenced code block", async () => {
      const fetch = stubFetch(says('```json\n{"translation":"你好"}\n```'));
      assert.deepEqual(await model(fetch).completeJson("translate"), { translation: "你好" });
      assert.equal(fetch.calls.length, 1, "fences are not worth a repair round-trip");
    });

    it("digs JSON out of surrounding prose", async () => {
      const fetch = stubFetch(says('Sure! Here you go: [{"a":1}] — hope that helps'));
      assert.deepEqual(await model(fetch).completeJson("translate"), [{ a: 1 }]);
    });

    it("repairs once when the reply is not JSON at all", async () => {
      const fetch = stubFetch(says("I'd be happy to help!"), says('{"translation":"你好"}'));
      assert.deepEqual(await model(fetch).completeJson("translate"), { translation: "你好" });

      assert.equal(fetch.calls.length, 2);
      const repair = fetch.calls[1]?.body["messages"] as { role: string; content: string }[];
      assert.equal(repair.length, 3, "the repair keeps the original exchange for context");
      assert.equal(repair[1]?.role, "assistant");
    });

    it("gives up after one repair rather than looping", async () => {
      const fetch = stubFetch(says("still not json"));
      await assert.rejects(model(fetch).completeJson("translate"), (error: ModelError) => {
        assert.equal(error.reason, "bad_response");
        return true;
      });
      assert.equal(fetch.calls.length, 2);
    });
  });

  describe("completeStream", () => {
    it("yields each delta, reassembling a line split across a chunk boundary", async () => {
      const fetch = stubFetch(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"こん"}}]}\n\ndata: {"choices":[{"delta":{"conte',
          'nt":"にちは"}}]}\n\ndata: [DONE]\n\n',
        ]),
      );

      assert.deepEqual(await collect(model(fetch).completeStream("hi")), ["こん", "にちは"]);
      assert.deepEqual(fetch.calls[0]?.body, {
        model: "some-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
    });

    it("skips a line it cannot parse instead of dying", async () => {
      const fetch = stubFetch(
        sseResponse(['data: not json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n']),
      );
      assert.deepEqual(await collect(model(fetch).completeStream("hi")), ["ok"]);
    });

    it("rejects on a bad status before yielding anything", async () => {
      const fetch = stubFetch(fails(401));
      await assert.rejects(collect(model(fetch).completeStream("hi")), (error: ModelError) => {
        assert.equal(error.reason, "auth");
        return true;
      });
    });

    it("does not retry — a partial answer already on screen should not be redone", async () => {
      const fetch = stubFetch(fails(503));
      await assert.rejects(collect(model(fetch).completeStream("hi")));
      assert.equal(fetch.calls.length, 1);
    });
  });

  describe("listModels", () => {
    it("lists model ids from the OpenAI-compatible /models shape, sorted", async () => {
      const fetch = stubFetch(
        new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }), {
          status: 200,
        }),
      );

      assert.deepEqual(await listModels(slot, fetch), ["gpt-4o", "gpt-4o-mini"]);
      assert.equal(fetch.calls[0]?.url, "https://api.example.com/v1/models");
    });

    it("sends the key as a bearer token, same as every other call", async () => {
      let seenAuth: string | null = null;
      const fetch = (async (_url: string | URL, init?: RequestInit) => {
        seenAuth =
          (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      await listModels(slot, fetch);
      assert.equal(seenAuth, "Bearer sk-test");
    });

    it("rejects with the same reasons a chat call would", async () => {
      const fetch = stubFetch(fails(401));
      await assert.rejects(listModels(slot, fetch), (error: ModelError) => {
        assert.equal(error.reason, "auth");
        return true;
      });
    });

    it("rejects rather than calling out with no base URL", async () => {
      await assert.rejects(listModels({ ...slot, baseUrl: "" }), (error: ModelError) => {
        assert.equal(error.reason, "bad_request");
        return true;
      });
    });

    it("rejects a response with no data array", async () => {
      const fetch = stubFetch(new Response(JSON.stringify({ oops: true }), { status: 200 }));
      await assert.rejects(listModels(slot, fetch), (error: ModelError) => {
        assert.equal(error.reason, "bad_response");
        return true;
      });
    });
  });
});
