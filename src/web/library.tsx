// The Library screen: the shelf, the one box you paste a link into, and the export
// that is the only thing standing between a Transcript and an evicted browser.

import { useEffect, useRef, useState } from "react";
import type { Episode, ImportPhase, Resource, Settings } from "../shared/model.ts";
import { backupFilename, buildBackup, parseBackup, planImport } from "./backup.ts";
import { useT } from "./i18n.ts";
import { startImport, retryImport, type ImportProgress } from "./import.ts";
import { buildImportDeps } from "./pipeline.ts";
import { createPodcastFeed } from "./podcast-feed.ts";
import { proxyUrl } from "./proxy.ts";
import { allEntries, listResources, readSettings, remove as removeResource } from "./store.ts";

/** The phase names double as i18n keys, so there is no second list to keep in step. */
const phaseKey = (phase: ImportPhase) => `phase.${phase}` as const;

/** mm:ss, or h:mm:ss past the hour — podcast episodes routinely run longer. */
const formatTime = (seconds: number) =>
  new Date(Math.max(0, seconds) * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

export function LibraryScreen() {
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState<Record<string, ImportProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const t = useT();

  // Which imports this tab is actually driving. An import lives in the page now
  // (ADR 0008), so this is the whole of what used to need an EventSource per job,
  // a map of unsubscribes closed on unmount, and a three-second timer to notice a
  // stream that had gone quiet. A reload abandons an import rather than orphaning
  // one, and an abandoned Resource is simply one in a running phase that nothing
  // here is running — no heuristic left to get wrong.
  const driving = useRef(new Set<string>());

  const refresh = () =>
    listResources().then(setResources, (failure: unknown) => setError(reason(failure)));

  useEffect(() => {
    void refresh();
    readSettings().then(
      (loaded) => setSettings(loaded ?? null),
      (failure: unknown) => setError(reason(failure)),
    );
  }, []);

  async function drive(
    id: string,
    work: (report: (p: ImportProgress) => void) => Promise<void>,
  ) {
    driving.current.add(id);
    setError(null);
    try {
      await work((progress) => setRunning((current) => ({ ...current, [id]: progress })));
    } catch (failure) {
      setError(reason(failure));
    } finally {
      driving.current.delete(id);
      setRunning((current) => {
        const { [id]: _done, ...rest } = current;
        return rest;
      });
      void refresh();
    }
  }

  async function retry(resource: Resource) {
    if (!settings) return setError(t("library.needsSettings"));
    const deps = buildImportDeps(settings);
    await drive(resource.id, (report) =>
      retryImport(deps, resource, report).then(() => undefined),
    );
  }

  async function remove(resource: Resource) {
    setConfirming(null);
    setError(null);
    try {
      await removeResource(resource.id);
    } catch (failure) {
      setError(reason(failure));
    }
    void refresh();
  }

  return (
    <main>
      <ImportBox
        settings={settings}
        onStart={(id, begin) => {
          void drive(id, async (report) => {
            await begin(report);
          });
          void refresh();
        }}
        onError={setError}
      />
      <Backup resources={resources} onImported={refresh} onError={setError} />
      {error && <p className="error">{error}</p>}
      {resources === null && <p className="notice">{t("common.loading")}</p>}
      {resources?.length === 0 && <p className="notice">{t("library.empty")}</p>}

      <ul className="shelf">
        {resources?.map((resource) => {
          const live = running[resource.id];
          const phase = live?.phase ?? resource.phase;
          const progress = live?.progress;
          const failureReason = resource.failureReason;
          // Failed, or left in a running phase by a reload that took its import with
          // it. Both need the same way out.
          const stalled =
            phase !== "ready" && (phase === "failed" || !driving.current.has(resource.id));
          // Transcription is the slow, billed step; translation runs after and fills
          // in as it goes (the Annotator's onBatch), so a Resource is worth opening as
          // soon as it has lines, not only once every line is translated too.
          const playable = phase === "ready" || phase === "annotating";
          return (
            <li key={resource.id} className={playable ? "ready" : ""}>
              <a href={playable ? `#/r/${encodeURIComponent(resource.id)}` : undefined}>
                <span className="title">{resource.title}</span>
                <span className="meta">
                  {formatTime(resource.durationSec)}
                  {" · "}
                  {resource.targetLanguage ?? t("library.autoLanguage")}→
                  {resource.nativeLanguage}
                  {resource.lastPositionSec
                    ? ` · ${t("library.resume", { time: formatTime(resource.lastPositionSec) })}`
                    : ""}
                </span>
                {phase !== "ready" && (
                  <span className={`phase ${phase}`}>
                    {t(phaseKey(phase))}
                    {progress !== undefined && ` ${Math.round(progress * 100)}%`}
                    {failureReason && `: ${failureReason}`}
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
                  {phase === "failed" ? t("library.retry") : t("library.resumeImport")}
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
                {confirming === resource.id ? t("common.sure") : t("common.delete")}
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/**
 * Export and import (ADR 0008). Not a convenience: `navigator.storage.persist()` was
 * refused by every engine measured, so nothing stops a browser evicting this Library
 * under disk pressure, and the file this writes is the only copy that survives it.
 *
 * Audio is not in it — it is some forty-five times the size of the Transcript beside
 * it and can be fetched again, while a Transcript costs money to make twice.
 */
function Backup({
  resources,
  onImported,
  onError,
}: {
  resources: Resource[] | null;
  onImported: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const t = useT();

  async function save() {
    try {
      const { backup } = buildBackup({ entries: await allEntries() });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFilename(backup.exportedAt);
      link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {
      onError(reason(failure));
    }
  }

  async function load(chosen: File) {
    setStatus(null);
    const parsed = parseBackup(await chosen.text());
    if (!parsed.ok) return onError(parsed.problem);

    const have = (resources ?? []).map((resource) => resource.id);
    const plan = planImport(have, parsed.backup);
    const { save: saveEntry } = await import("./store.ts");
    for (const entry of plan.add) {
      await saveEntry({ resource: entry.resource, transcript: entry.transcript });
    }
    setStatus(
      t("library.imported", { added: plan.add.length, skipped: plan.alreadyHere.length }),
    );
    onImported();
  }

  return (
    <section className="backup">
      <button type="button" className="ghost" onClick={() => void save()}>
        {t("library.exportBackup")}
      </button>
      <button type="button" className="ghost" onClick={() => file.current?.click()}>
        {t("library.importBackup")}
      </button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          // Cleared so choosing the same file twice fires again.
          event.target.value = "";
          if (chosen) void load(chosen);
        }}
      />
      {status && <span className="notice">{status}</span>}
    </section>
  );
}

/**
 * One input for a podcast feed. YouTube is gone with yt-dlp (ADR 0009), so there is
 * no second branch to pick between any more.
 */
function ImportBox({
  settings,
  onStart,
  onError,
}: {
  settings: Settings | null;
  onStart: (
    id: string,
    begin: (report: (p: ImportProgress) => void) => Promise<unknown>,
  ) => void;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<{ feedTitle: string; episodes: Episode[] } | null>(null);
  const t = useT();

  async function listEpisodes(feedUrl: string) {
    if (!settings) return onError(t("library.needsSettings"));
    setBusy(true);
    onError("");
    try {
      const podcast = createPodcastFeed({
        proxyUrl: (target) => proxyUrl(settings.proxy, target),
      });
      setFeed(await podcast.listEpisodes(feedUrl));
    } catch (failure) {
      onError(reason(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          if (trimmed) void listEpisodes(trimmed);
        }}
      >
        <input
          value={url}
          placeholder={t("library.placeholder")}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button disabled={busy}>{busy ? t("library.working") : t("library.import")}</button>
      </form>

      {feed && (
        <div className="episodes">
          <h2>{feed.feedTitle}</h2>
          <ul>
            {feed.episodes.map((episode) => (
              <li key={episode.audioUrl}>
                <button
                  disabled={busy || !settings}
                  onClick={() => {
                    if (!settings) return;
                    // The id is decided here rather than inside the import, so progress
                    // and the "is this tab driving it" check are keyed by the Resource
                    // from the first tick. Keying them by anything else leaves the shelf
                    // showing a Resume button beside a running import.
                    const id = crypto.randomUUID();
                    const deps = { ...buildImportDeps(settings), newId: () => id };
                    onStart(id, (report) =>
                      startImport(
                        deps,
                        {
                          source: {
                            kind: "podcast",
                            feedUrl: url.trim(),
                            episodeUrl: episode.audioUrl,
                            title: episode.title,
                          },
                          title: episode.title,
                          ...(episode.durationSec && { durationSec: episode.durationSec }),
                        },
                        report,
                      ),
                    );
                    setFeed(null);
                    setUrl("");
                  }}
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
