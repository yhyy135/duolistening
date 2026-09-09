// The Library screen: the shelf, the one box you paste a link into, and the export
// that is the only thing standing between a Transcript and an evicted browser.

import { useEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  LANGUAGE_NAMES,
  type Episode,
  type ImportPhase,
  type LanguageCode,
  type Resource,
  type Settings,
} from "../shared/model.ts";
import { backupFilename, buildBackup, parseBackup, planImport } from "./backup.ts";
import { Icon } from "./icons.tsx";
import { useT } from "./i18n.ts";
import {
  LANGUAGE_LEARNING_GENRE,
  MARKETS,
  recommendedFor,
  searchPodcasts,
  type PodcastSuggestion,
} from "./itunes.ts";
import { startImport, retryImport, type ImportProgress } from "./import.ts";
import { buildImportDeps } from "./pipeline.ts";
import { createPodcastFeed } from "./podcast-feed.ts";
import { proxyUrl } from "./proxy.ts";
import { allEntries, listResources, readSettings, remove as removeResource } from "./store.ts";

/** The phase names double as i18n keys, so there is no second list to keep in step. */
const phaseKey = (phase: ImportPhase) => `phase.${phase}` as const;

/**
 * How many episodes of a feed to show at once. A weekly show that has been running
 * five years answers with several hundred, and rendering all of them buries the shelf
 * under a list nobody scrolled to. The feed is parsed once and held whole — this is a
 * display cap, not a second request, so "show more" costs nothing.
 */
const PAGE = 10;

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
  /** A feed the recommendations sent over, for the box below to open. */
  const [handed, setHanded] = useState("");
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
        handed={handed}
        onHandled={() => setHanded("")}
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
          // Stored audio is the real answer, whatever the phase says: an import that
          // downloaded an episode and then failed to transcribe it left something that
          // plays, and refusing to open it would be withholding bytes we already have.
          // The two phases beside it are for Resources with no `hasAudio` — `ready`
          // from before the field existed or restored from a backup, and `annotating`
          // from the old pipeline, which no import enters any more (ADR 0011).
          const playable = resource.hasAudio || phase === "ready" || phase === "annotating";
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

      {/* Under the shelf, not above it. A reader with episodes came back for those;
          a reader without any has an empty shelf and this is what fills the screen. */}
      <Recommended settings={settings} onPick={setHanded} />
    </main>
  );
}

/** Remembered so the day's one request can happen without asking again every visit. */
const DISCOVER_KEY = "duolistening.discover";

/**
 * The day's recommendations.
 *
 * Apple's top-charts feed sends no CORS headers and cannot be read from a page at
 * all, so "what is popular" is approximated by what a storefront answers for that
 * language's own search terms — which for someone studying the language is the better
 * list anyway, and it arrives with the `feedUrl` an import needs. `itunes.ts` owns the
 * queries and the once-a-day cache; this only decides which language to ask about.
 *
 * The network is touched exactly twice a day per language, and once more each time
 * the reader types a search. Nothing else here reaches out.
 */
function Recommended({
  settings,
  onPick,
}: {
  settings: Settings | null;
  onPick: (feedUrl: string) => void;
}) {
  const t = useT();
  const [language, setLanguage] = useState<LanguageCode | null>(null);
  const [items, setItems] = useState<PodcastSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [term, setTerm] = useState("");
  // Bumped by the ✕ to re-run the effect below without a second copy of what it
  // does: the language has not changed, so nothing else would tell it to.
  const [refresh, setRefresh] = useState(0);

  // What the reader said they are studying, else whichever language they last asked
  // about here. Both unset is the honest case rather than a default: the studied
  // language is optional by design, and guessing one would recommend Spanish to
  // somebody learning Korean. The chips below are then the only way in.
  useEffect(() => {
    setLanguage((chosen) => chosen ?? settings?.targetLanguage ?? stored());
  }, [settings]);

  useEffect(() => {
    if (!language) return;
    setBusy(true);
    setFailed(false);
    recommendedFor(language)
      .then(setItems, () => setFailed(true))
      .finally(() => setBusy(false));
  }, [language, refresh]);

  // Back to the day's list: the cache in itunes.ts means this is free in the normal
  // case, same as picking a language chip is.
  function clearSearch() {
    setTerm("");
    setItems(null);
    setRefresh((generation) => generation + 1);
  }

  function choose(code: LanguageCode) {
    // Through clearSearch, so the chip already showing as chosen still reloads. Its
    // own setLanguage is a no-op in that case, the effect's deps never change, and
    // the list it just emptied would stay empty for as long as the screen is open.
    clearSearch();
    setLanguage(code);
    try {
      localStorage.setItem(DISCOVER_KEY, code);
    } catch {
      // Private mode. The chip still works for this visit, which is all it owes.
    }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const wanted = term.trim();
    if (!wanted || !language) return;
    setBusy(true);
    setFailed(false);
    try {
      // Deliberately past the cache: a search is the reader asking for something the
      // day's list did not have.
      setItems(await searchPodcasts({ term: wanted, country: MARKETS[language].country }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="discover">
      <h2>
        <Icon name="compass" />
        {t("discover.title")}
      </h2>
      <p className="hint">{t("discover.subtitle")}</p>

      <div className="chips">
        {LANGUAGES.map((code) => (
          <button
            key={code}
            type="button"
            className={code === language ? "on" : ""}
            aria-pressed={code === language}
            onClick={() => choose(code)}
          >
            {LANGUAGE_NAMES[code]}
          </button>
        ))}
      </div>

      {language && (
        <form onSubmit={(event) => void search(event)}>
          <span className="search-field">
            <input
              value={term}
              placeholder={t("discover.searchPlaceholder")}
              onChange={(event) => setTerm(event.target.value)}
            />
            {term && (
              <button
                type="button"
                className="clear"
                aria-label={t("discover.clearSearch")}
                onClick={clearSearch}
              >
                ✕
              </button>
            )}
          </span>
          <button disabled={busy}>{t("discover.search")}</button>
        </form>
      )}

      {!language && <p className="notice">{t("discover.pickLanguage")}</p>}
      {busy && <p className="notice">{t("discover.loading")}</p>}
      {failed && <p className="error">{t("discover.failed")}</p>}
      {items?.length === 0 && !busy && <p className="notice">{t("discover.empty")}</p>}

      <ul className="suggestions">
        {items?.map((suggestion) => (
          <li key={suggestion.collectionId}>
            <button type="button" onClick={() => onPick(suggestion.feedUrl)}>
              {/* Straight from Apple's CDN, which needs no proxy for an <img> and no
                  key. The cost is one outbound request per card and a blank square
                  offline, which is why nothing but the artwork depends on it. */}
              <img src={suggestion.artworkUrl} alt="" loading="lazy" width="56" height="56" />
              <span className="who">
                <span className="title">{suggestion.title}</span>
                {/* Beside the author rather than out at the right margin: a pill on
                    its own column costs a third of a phone's width, and the title it
                    took that width from is what the reader is actually reading. */}
                <span className="meta">
                  <span className="author">{suggestion.author}</span>
                  {suggestion.genreIds.includes(LANGUAGE_LEARNING_GENRE) && (
                    <span className="badge">{t("discover.languageLearning")}</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function stored(): LanguageCode | null {
  try {
    const code = localStorage.getItem(DISCOVER_KEY);
    // Anything else is a language this build no longer offers, or someone else's key.
    return LANGUAGES.includes(code as LanguageCode) ? (code as LanguageCode) : null;
  } catch {
    return null;
  }
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
        <Icon name="download" />
        {t("library.exportBackup")}
      </button>
      <button type="button" className="ghost" onClick={() => file.current?.click()}>
        <Icon name="upload" />
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
  handed,
  onHandled,
  onStart,
  onError,
}: {
  settings: Settings | null;
  /** A feed URL the recommendations below sent up, or "" for nothing pending. */
  handed: string;
  onHandled: () => void;
  onStart: (
    id: string,
    begin: (report: (p: ImportProgress) => void) => Promise<unknown>,
  ) => void;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<{ feedTitle: string; episodes: Episode[] } | null>(null);
  /** How much of the parsed feed is on screen. Reset with every feed, or the second
      show opens already scrolled past its own first ten episodes. */
  const [shown, setShown] = useState(PAGE);
  const box = useRef<HTMLElement>(null);
  const t = useT();

  // A recommendation, opened in the one episode picker this screen has rather than a
  // second one beside it. Cleared as soon as it is taken, so picking the same show
  // again after importing from it is not a dead click. The scroll is not decoration:
  // the card was tapped at the bottom of the page and the episodes appear at the top.
  useEffect(() => {
    if (!handed) return;
    setUrl(handed);
    void listEpisodes(handed).then(() =>
      box.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
    onHandled();
  }, [handed]);

  async function listEpisodes(feedUrl: string) {
    if (!settings) return onError(t("library.needsSettings"));
    setBusy(true);
    onError("");
    try {
      const podcast = createPodcastFeed({
        proxyUrl: (target) => proxyUrl(settings.proxy, target),
      });
      setFeed(await podcast.listEpisodes(feedUrl));
      setShown(PAGE);
    } catch (failure) {
      onError(reason(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import" ref={box}>
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
            {feed.episodes.slice(0, shown).map((episode) => (
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
          {shown < feed.episodes.length && (
            <button type="button" className="more" onClick={() => setShown(shown + PAGE)}>
              {t("library.showMore", {
                count: Math.min(PAGE, feed.episodes.length - shown),
              })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
