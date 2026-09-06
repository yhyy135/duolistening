// The Library screen: the shelf, plus the one box you paste a link into.

import { useEffect, useRef, useState } from "react";
import type { Episode, ImportPhase, JobState, Resource, SourceRef } from "../shared/model.ts";
import { api, reason } from "./api.ts";

const PHASE_LABEL: Record<ImportPhase, string> = {
  queued: "Queued",
  fetching: "Downloading",
  transcribing: "Transcribing",
  annotating: "Translating",
  ready: "Ready",
  failed: "Failed",
};

/** mm:ss, or h:mm:ss past the hour — podcast episodes routinely run longer. */
const formatTime = (seconds: number) =>
  new Date(Math.max(0, seconds) * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);

export function LibraryScreen() {
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [error, setError] = useState<string | null>(null);
  // Closed on unmount: a browser only allows a handful of connections per host, and
  // a forgotten stream is one the <audio> element on the player screen can't have.
  const watching = useRef(new Set<() => void>());
  useEffect(() => () => watching.current.forEach((stop) => stop()), []);

  const refresh = () =>
    api.library().then(setResources, (failure: unknown) => setError(reason(failure)));
  useEffect(() => {
    void refresh();
  }, []);

  /**
   * Follow a job to its end, then refetch — the shelf is the source of truth, and
   * the job only exists to say what is happening in the meantime.
   */
  function follow(started: JobState): void {
    setJobs((current) => ({ ...current, [started.resourceId]: started }));
    void refresh();
    const stop = api.watchImport(started.id, (state) => {
      setJobs((current) => ({ ...current, [state.resourceId]: state }));
      if (state.phase === "ready" || state.phase === "failed") void refresh();
    });
    watching.current.add(stop);
  }

  async function retry(resource: Resource) {
    setError(null);
    try {
      follow(await api.retry(resource.id));
    } catch (failure) {
      setError(reason(failure));
    }
  }

  async function remove(resource: Resource) {
    if (!confirm(`Delete “${resource.title}” and its transcript?`)) return;
    await api.remove(resource.id);
    void refresh();
  }

  return (
    <main>
      <ImportBox onStarted={follow} />
      {error && <p className="error">{error}</p>}
      {resources === null && <p className="notice">Loading…</p>}
      {resources?.length === 0 && <p className="notice">Nothing imported yet.</p>}

      <ul className="shelf">
        {resources?.map((resource) => {
          // A live job knows more than the shelf entry it was read from.
          const phase = jobs[resource.id]?.phase ?? resource.phase;
          const progress = jobs[resource.id]?.progress;
          const reason = jobs[resource.id]?.failureReason ?? resource.failureReason;
          // A Resource this page is not watching has no job in sight: either it
          // failed, or a restart abandoned it mid-phase. Both need the same way out,
          // and the server refuses the retry if one is in fact still running.
          const watched = jobs[resource.id];
          const stalled =
            phase !== "ready" && (!watched || watched.phase === "failed" || phase === "failed");
          return (
            <li key={resource.id} className={phase === "ready" ? "ready" : ""}>
              <a
                href={phase === "ready" ? `#/r/${encodeURIComponent(resource.id)}` : undefined}
              >
                <span className="title">{resource.title}</span>
                <span className="meta">
                  {formatTime(resource.durationSec)}
                  {" · "}
                  {resource.targetLanguage}→{resource.nativeLanguage}
                  {resource.lastPositionSec
                    ? ` · resume ${formatTime(resource.lastPositionSec)}`
                    : ""}
                </span>
                {phase !== "ready" && (
                  <span className={`phase ${phase}`}>
                    {PHASE_LABEL[phase]}
                    {progress !== undefined && ` ${Math.round(progress * 100)}%`}
                    {reason && `: ${reason}`}
                  </span>
                )}
              </a>
              {stalled && (
                <button onClick={() => void retry(resource)}>
                  {phase === "failed" ? "Retry" : "Resume"}
                </button>
              )}
              <button className="ghost" onClick={() => void remove(resource)}>
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/** Host-exact, so a look-alike domain falls through to the podcast branch. */
function isYouTube(url: string): boolean {
  try {
    return /^(www\.|m\.)?(youtube\.com|youtu\.be)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * One input for both source kinds: a YouTube link imports straight away, anything
 * else is treated as a podcast feed and opens its episode list.
 */
function ImportBox({ onStarted }: { onStarted: (state: JobState) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ feedTitle: string; episodes: Episode[] } | null>(null);

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setBusy(false);
    }
  }

  const start = (source: SourceRef) =>
    attempt(async () => {
      onStarted(await api.startImport(source));
      setFeed(null);
      setUrl("");
    });

  return (
    <section className="import">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          if (!trimmed) return;
          if (isYouTube(trimmed)) return void start({ kind: "youtube", url: trimmed });
          void attempt(async () => setFeed(await api.episodes(trimmed)));
        }}
      >
        <input
          value={url}
          placeholder="YouTube link, or a podcast RSS feed"
          onChange={(event) => setUrl(event.target.value)}
        />
        <button disabled={busy}>{busy ? "Working…" : "Import"}</button>
      </form>
      {error && <p className="error">{error}</p>}

      {feed && (
        <div className="episodes">
          <h2>{feed.feedTitle}</h2>
          <ul>
            {feed.episodes.map((episode) => (
              <li key={episode.audioUrl}>
                <button
                  disabled={busy}
                  onClick={() =>
                    start({
                      kind: "podcast",
                      feedUrl: url.trim(),
                      episodeUrl: episode.audioUrl,
                      title: episode.title,
                    })
                  }
                >
                  {episode.title}
                </button>
                <span className="meta">
                  {episode.publishedAt?.slice(0, 10)}
                  {episode.durationSec ? ` · ${formatTime(episode.durationSec)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
