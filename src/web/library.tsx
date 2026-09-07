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
  const [silent, setSilent] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Closed on unmount: a browser only allows a handful of connections per host, and
  // a forgotten stream is one the <audio> element on the player screen can't have.
  // Keyed by Resource, because that is also what keeps one stream per import.
  const watching = useRef(new Map<string, () => void>());
  useEffect(() => () => watching.current.forEach((stop) => stop()), []);

  const refresh = () =>
    api.library().then(setResources, (failure: unknown) => setError(reason(failure)));
  useEffect(() => {
    void refresh();
  }, []);

  function watch(id: string): void {
    watching.current.get(id)?.();
    const stop = api.watchImport(id, (state) => {
      setJobs((current) => ({ ...current, [state.resourceId]: state }));
      if (state.phase === "ready" || state.phase === "failed") void refresh();
    });
    watching.current.set(id, stop);
    // The server answers 404 for a job it no longer holds — a restart mid-import —
    // and EventSource reports that as silence rather than as anything a caller can
    // see. A stream that has said nothing by now is therefore how an abandoned
    // import is recognised, and is what puts its Resume button back.
    // ponytail: a fixed wait. The alternative is a route that answers whether a job
    // is live, and one timer beats a whole endpoint until this is wrong for someone.
    setTimeout(() => setSilent((current) => ({ ...current, [id]: true })), 3000);
  }

  // A reload forgets every job while the server keeps importing, and the shelf only
  // records phase changes — never progress. Re-subscribing to whatever is unfinished
  // is what brings the percentage, the bar and the finished-at-last refetch back.
  useEffect(() => {
    for (const resource of resources ?? []) {
      if (resource.phase === "ready" || resource.phase === "failed") continue;
      if (!watching.current.has(resource.id)) watch(resource.id);
    }
  }, [resources]);

  /**
   * Follow a job to its end, then refetch — the shelf is the source of truth, and
   * the job only exists to say what is happening in the meantime.
   */
  function follow(started: JobState): void {
    setJobs((current) => ({ ...current, [started.resourceId]: started }));
    void refresh();
    watch(started.id);
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
    setConfirming(null);
    setError(null);
    try {
      await api.remove(resource.id);
    } catch (failure) {
      setError(reason(failure));
    }
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
          // A Resource with no job in sight either failed or was abandoned mid-phase
          // by a restart. Both need the same way out, and the server refuses the
          // retry if one is in fact still running. An import that has only just been
          // subscribed to looks the same, though, so it is the stream's silence that
          // counts here and not the mere absence of a job.
          const watched = jobs[resource.id];
          const stalled =
            phase !== "ready" && (phase === "failed" || (!watched && !!silent[resource.id]));
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
                {/* An import runs for minutes, and a percentage only reads once you
                    stop to read it. A bar reads while scrolling past. */}
                {progress !== undefined && phase !== "ready" && (
                  <progress value={progress} max={1} />
                )}
              </a>
              {stalled && (
                <button onClick={() => void retry(resource)}>
                  {phase === "failed" ? "Retry" : "Resume"}
                </button>
              )}
              {/* Two clicks on one button rather than confirm(): that dialog blocks
                  the page, cannot be styled to match either theme, and reads as a
                  browser error. Focus leaving the button disarms it. */}
              <button
                className="ghost"
                onBlur={() => setConfirming(null)}
                onClick={() =>
                  confirming === resource.id
                    ? void remove(resource)
                    : setConfirming(resource.id)
                }
              >
                {confirming === resource.id ? "Sure?" : "Delete"}
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
