// The only place the web half knows the server exists. Everything above it deals in
// model types, never in URLs, status codes or EventSource.
//
// There is no token to juggle: POST /api/session sets an httpOnly cookie, and the
// cookie is what `fetch`, `<audio>` and `EventSource` all carry (app.ts accepts a
// bearer header too, but only a non-browser client needs that).

import type {
  Episode,
  JobId,
  JobState,
  Resource,
  ResourceId,
  Settings,
  SettingsCheck,
  SourceRef,
  Transcript,
} from "../shared/model.ts";

export interface PlayableResource {
  resource: Resource;
  transcript: Transcript;
  /** Fetched per request, never cached: an S3 presigned URL expires. */
  playbackUrl: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Called whenever the server rejects the session, so the shell can put the password
 * gate back up from wherever the user happened to be.
 */
export let onUnauthorized = (): void => {};
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

/** What a caller shows the user when any of the calls below throws. */
export const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError("unauthorized", 401);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(
      body.error ?? `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const send = <T>(path: string, method: string, body: unknown) =>
  request<T>(path, { method, body: JSON.stringify(body) });

export const api = {
  /** Resolves when the session is good; throws ApiError(401) when a password is wanted. */
  session: () => request<{ ok: true; required: boolean }>("/api/session"),
  login: (password: string) => send<void>("/api/session", "POST", { password }),

  settings: () => request<Settings>("/api/settings"),
  /** Send a masked apiKey back untouched to leave the stored key alone. */
  saveSettings: (settings: Settings) => send<Settings>("/api/settings", "PUT", settings),
  /** Tries both slots without storing anything; masked keys are merged server-side. */
  checkSettings: (settings: Settings) =>
    send<SettingsCheck>("/api/settings/check", "POST", settings),

  library: () => request<Resource[]>("/api/library"),
  resource: (id: ResourceId) => request<PlayableResource>(`/api/library/${id}`),
  remove: (id: ResourceId) => request<void>(`/api/library/${id}`, { method: "DELETE" }),
  savePosition: (id: ResourceId, seconds: number) =>
    send<void>(`/api/library/${id}/position`, "PUT", { seconds }),
  /**
   * The same save, for the moments a normal request can't be trusted to finish: the
   * tab closing, the browser quitting, iOS Safari backgrounding the page. `fetch` can
   * be aborted mid-flight once the page starts tearing down; the browser queues a
   * beacon to complete regardless. It can only POST — the server route answers to
   * both — and can't set headers, so the content type rides on the Blob itself, which
   * is what lets the same JSON parsing on the server read the body.
   */
  savePositionBeacon: (id: ResourceId, seconds: number): void => {
    const body = new Blob([JSON.stringify({ seconds })], { type: "application/json" });
    navigator.sendBeacon(`/api/library/${id}/position`, body);
  },
  /** Resumes a failed or abandoned import; the reply is a job to watch, as for a new one. */
  retry: (id: ResourceId) => send<JobState>(`/api/library/${id}/retry`, "POST", {}),

  episodes: (feedUrl: string) =>
    request<{ feedTitle: string; episodes: Episode[] }>(
      `/api/podcast/episodes?feedUrl=${encodeURIComponent(feedUrl)}`,
    ),

  startImport: (source: SourceRef) => send<JobState>("/api/imports", "POST", { source }),

  /**
   * Streams an import's progress until it settles, then closes. Returns an
   * unsubscribe for the case where the user navigates away first — without it
   * EventSource reconnects forever to a stream nobody is reading.
   */
  watchImport(id: JobId, onState: (state: JobState) => void): () => void {
    const stream = new EventSource(`/api/imports/${id}/events`);
    stream.onmessage = (event) => {
      const state = JSON.parse(event.data as string) as JobState;
      onState(state);
      if (state.phase === "ready" || state.phase === "failed") stream.close();
    };
    // The server ends the stream on completion; a genuine drop is not worth a retry
    // loop, since the Library refetch below is the source of truth either way.
    stream.onerror = () => stream.close();
    return () => stream.close();
  },

  /**
   * Streams the ask-AI answer as plain Markdown text, chunk by chunk, so the popup
   * can render it as it arrives instead of waiting for the whole reply.
   */
  async askStream(text: string, onChunk: (chunk: string) => void): Promise<void> {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new ApiError("unauthorized", 401);
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(
        body.error ?? `${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value, { stream: true }));
    }
  },
};
