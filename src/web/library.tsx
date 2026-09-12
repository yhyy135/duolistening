// The Library screen: the shelf, the one box you paste a link into, and the export
// that is the only thing standing between a Transcript and an evicted browser.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  type Episode,
  type ImportPhase,
  type LanguageCode,
  type Resource,
  type Settings,
} from "../shared/model.ts";
import { backupFilename, buildBackup, parseBackup, planImport } from "./backup.ts";
import { Icon } from "./icons.tsx";
import { useLanguageName, useT } from "./i18n.ts";
import {
  LANGUAGE_LEARNING_GENRE,
  MARKETS,
  recommendedFor,
  searchPodcasts,
  type PodcastSuggestion,
} from "./itunes.ts";
import { isImporting, startImport, retryImport, type ImportProgress } from "./import.ts";
import { buildImportDeps } from "./pipeline.ts";
import { createPodcastFeed } from "./podcast-feed.ts";
import { proxyUrl } from "./proxy.ts";
import { allEntries, listResources, readSettings, remove as removeResource } from "./store.ts";

/** The phase names double as i18n keys, so there is no second list to keep in step. */
const phaseKey = (phase: ImportPhase) => `phase.${phase}` as const;

/**
 * How many episodes of a feed to render at a time. A weekly show that has been running
 * five years answers with several hundred, and mounting all of them is a stall on the
 * click that opens the picker. The feed is parsed once and held whole — this is a
 * display cap, not a second request, so the rest costs nothing but the rows.
 */
const PAGE = 20;

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
  const languageOf = useLanguageName();

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
    setError(null);
    try {
      await work((progress) => setRunning((current) => ({ ...current, [id]: progress })));
    } catch (failure) {
      setError(reason(failure));
    } finally {
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
          // it. Both need the same way out — and neither is true of an import that is
          // running right now, which is why this asks `import.ts` rather than a Set of
          // its own: this screen never knew about a transcription started from the
          // player, and offered a Resume that billed the episode a second time.
          const stalled = phase !== "ready" && !isImporting(resource.id);
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
                  {resource.targetLanguage
                    ? languageOf(resource.targetLanguage)
                    : t("library.autoLanguage")}
                  →{languageOf(resource.nativeLanguage)}
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
              {/* Two clicks rather than confirm(): that dialog blocks the page, cannot
                  be styled to match either theme, and reads as a browser error.
                  The second click is deliberately not in the same place as the first.
                  Delete sits at the end of the row, so arming puts Cancel there — under
                  whatever just clicked Delete — and Confirm to its left, where nothing
                  has been clicked yet. A double-click, the mis-operation this is
                  actually guarding against, therefore lands on Cancel. Cancel also
                  takes focus, so a reflexive Enter goes the same safe way. */}
              {confirming === resource.id ? (
                // One blur handler for the pair, not one each: focus moving from Cancel
                // to Confirm is still focus inside the confirmation, and disarming on it
                // would make the pair impossible to reach with a keyboard.
                <span
                  className="confirm"
                  onBlur={(event) => {
                    // A null `relatedTarget` is focus going nowhere, and that is what a
                    // plain click on a button reports in WebKit — it blurs whatever had
                    // focus and focuses nothing. Treating it as focus leaving unmounted
                    // Confirm between mousedown and mouseup, so the click never reached
                    // it and the episode stayed on the shelf. Only a move to another
                    // element disarms; an armed pair otherwise waits for Cancel, Confirm,
                    // or the next Delete.
                    if (
                      event.relatedTarget &&
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setConfirming(null);
                  }}
                >
                  <button className="ghost danger" onClick={() => void remove(resource)}>
                    {t("common.confirm")}
                  </button>
                  <button className="ghost" autoFocus onClick={() => setConfirming(null)}>
                    {t("common.cancel")}
                  </button>
                </span>
              ) : (
                <button className="ghost" onClick={() => setConfirming(resource.id)}>
                  {t("common.delete")}
                </button>
              )}
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
  const languageOf = useLanguageName();
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
            {languageOf(code)}
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
  /** Which feed the dialog is showing. Not the box above it — a recommendation opens
      the picker without touching an input that belongs to whoever is typing in it. */
  const [listed, setListed] = useState("");
  /** Why the list could not be fetched — shown in the dialog the list would have been. */
  const [failure, setFailure] = useState<string | null>(null);
  /** How much of the parsed feed is on screen. Reset with every feed, or the second
      show opens already scrolled past its own first ten episodes. */
  const [shown, setShown] = useState(PAGE);
  /** The one episode showing its title in full, by `audioUrl`. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Which titles the column actually cut, by `audioUrl`. Only those get a ⋯. */
  const [clipped, setClipped] = useState<Record<string, boolean>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** The feed request in flight, so the dialog's Cancel can drop it. */
  const fetching = useRef<AbortController | null>(null);
  const rowsRef = useRef<HTMLTableSectionElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // A recommendation, opened in the one episode picker this screen has rather than a
  // second one beside it. Cleared as soon as it is taken, so picking the same show
  // again after importing from it is not a dead click. Nothing is scrolled into view
  // any more: the picker is a modal, and it opens where the reader is already looking.
  useEffect(() => {
    if (!handed) return;
    void listEpisodes(handed);
    onHandled();
  }, [handed]);

  // Measured, because whether a title fits depends on the dialog's width and the
  // reader's font: a character count is wrong in both directions, and wrong by most
  // for the CJK titles that run out of room in half the characters. An offer to show
  // the rest of a title that has no rest is a control that does nothing, on every row.
  //
  // Rows already measured are left alone, so an expanded title — which now wraps, and
  // therefore "fits" — does not lose the ⋯ that expanded it. The ceiling is a window
  // resized while the list is open: those rows keep the answer they were given.
  useLayoutEffect(() => {
    const picks = rowsRef.current?.querySelectorAll<HTMLElement>(".pick") ?? [];
    const found: Record<string, boolean> = {};
    picks.forEach((pick, at) => {
      const key = feed?.episodes[at]?.audioUrl;
      if (key && !(key in clipped)) found[key] = pick.scrollWidth > pick.clientWidth;
    });
    if (Object.keys(found).length > 0) setClipped((current) => ({ ...current, ...found }));
  }, [feed, shown]);

  // Back to the top for every new list. The dialog keeps its list mounted between
  // openings, so the second show would otherwise open part-way down, wherever whoever
  // scrolled the first one left it. It has to happen here rather than beside the other
  // resets in `listEpisodes`: a closed <dialog> is `display: none`, a scroll written to
  // a hidden element does not stick, and the browser hands back the old offset when it
  // is shown again — measured, 107px into a list that had just been replaced.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [feed]);

  // The next page arrives when the reader reaches the end of this one. An observer
  // rather than a scroll handler on the list: it also fires when the sentinel is
  // already on screen, and a feed of twenty-two episodes on a tall window never
  // scrolls — the last two would be unreachable, with nothing left to click.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown((at) => at + PAGE);
      },
      // Against the list rather than the viewport, which is what makes the margin mean
      // anything: it is the list that scrolls, so the next page lands before the last
      // row does.
      { root: listRef.current, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [feed, shown]);

  async function listEpisodes(feedUrl: string) {
    if (!settings) return onError(t("library.needsSettings"));
    // A second recommendation replaces the first rather than racing it: whichever
    // answered last would otherwise be the list on screen.
    fetching.current?.abort();
    const attempt = new AbortController();
    fetching.current = attempt;
    setBusy(true);
    setFeed(null);
    setFailure(null);
    onError("");
    // Opened before the request and not after it. A feed is fetched whole before there
    // is anything to show, which is seconds on a long archive, and a click on a
    // recommendation used to leave the screen exactly as it was for all of them — no
    // way to tell it had been heard, and nothing to press to take it back. The modal
    // this already had is the mask: `showModal()` throws on a dialog that is already
    // open, and picking a second recommendation is exactly how that would happen.
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    try {
      const podcast = createPodcastFeed({
        proxyUrl: (target) => proxyUrl(settings.proxy, target),
      });
      const listing = await podcast.listEpisodes(feedUrl, attempt.signal);
      // A reply that arrives after its attempt was cancelled or replaced is not the
      // list anybody is waiting for — an abort cannot reach one already on its way back.
      if (fetching.current !== attempt) return;
      setFeed(listing);
      setListed(feedUrl);
      setShown(PAGE);
      setExpanded(null);
      setClipped({});
    } catch (problem) {
      // A cancelled request is not a failure and has no dialog left to be shown in —
      // closing it is what aborted this.
      if (attempt.signal.aborted) return;
      // Into the dialog rather than up onto the shelf, where the message sat above the
      // recommendations with nothing around it saying what had been asked for. Whether
      // the list arrived or not, the answer to "list this feed" lands in one place.
      setFeed(null);
      setFailure(reason(problem));
    } finally {
      // Only for the attempt still on screen. The one this replaced settles a moment
      // later, and clearing the flag there would take the new request's own wait down.
      if (fetching.current === attempt) setBusy(false);
    }
  }

  /**
   * Out of the picker, whichever way: the button below, Esc, or a pick. It drops the
   * request first, because a feed nobody is waiting for is still being paid for — the
   * bytes go through the reader's own proxy.
   */
  function dismiss() {
    fetching.current?.abort();
    fetching.current = null;
    setBusy(false);
    dialogRef.current?.close();
  }

  function pick(episode: Episode) {
    if (!settings) return;
    // The id is decided here rather than inside the import, so progress and the "is
    // this tab driving it" check are keyed by the Resource from the first tick. Keying
    // them by anything else leaves the shelf showing a Resume button beside a running
    // import.
    const id = crypto.randomUUID();
    const deps = { ...buildImportDeps(settings), newId: () => id };
    onStart(id, (report) =>
      startImport(
        deps,
        {
          source: {
            kind: "podcast",
            feedUrl: listed,
            episodeUrl: episode.audioUrl,
            title: episode.title,
          },
          title: episode.title,
          ...(episode.durationSec && { durationSec: episode.durationSec }),
        },
        report,
      ),
    );
    dismiss();
    setFeed(null);
    // Only if the box is what opened this list. A recommendation never filled it, and
    // emptying it would throw away a link somebody had typed and not imported yet.
    if (url.trim() === listed) setUrl("");
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
        {/* The same wrapper the podcast search below uses, and the same ✕ inside it:
            one long feed URL is exactly as tedious to clear by hand as one search. */}
        <span className="search-field">
          <input
            value={url}
            placeholder={t("library.placeholder")}
            onChange={(event) => setUrl(event.target.value)}
          />
          {url && (
            <button
              type="button"
              className="clear"
              aria-label={t("library.clearUrl")}
              onClick={() => setUrl("")}
            >
              ✕
            </button>
          )}
        </span>
        <button disabled={busy}>{busy ? t("library.working") : t("library.import")}</button>
      </form>

      {/* One dialog for both answers a feed can give. A modal rather than a block that
          pushes the shelf down: a feed's episodes are a decision to make now, and the
          list used to appear above a screen the reader was already scrolled past. */}
      {/* `onClose` for Esc, and the button below calls the same function rather than
          leaving it to the event this raises: a hidden page never delivers a dialog's
          `close`, so that route cannot be measured, and the one a finger takes should
          not be the unmeasurable one. `close()` on a closed dialog raises nothing, so
          arriving both ways costs one no-op. */}
      <dialog ref={dialogRef} className="ask-dialog episodes-dialog" onClose={dismiss}>
        {/* The wait, in the dialog the list will appear in — not an overlay of its own,
            which would be a second mask over the one a modal already draws. An
            indeterminate <progress> because there is no fraction to report: a feed
            arrives whole or not at all. */}
        {busy && (
          <>
            <p className="text">{t("library.working")}</p>
            <progress />
          </>
        )}
        {feed && (
          <>
            <p className="text">{feed.feedTitle}</p>
            <p className="note">{t("library.pickEpisode")}</p>
            {/* The scroll is here and not on the dialog, so the show's name, the
                header row and the buttons stay put while three hundred episodes move. */}
            <div className="list" ref={listRef}>
              <table className="episodes">
                <thead>
                  <tr>
                    <th>{t("library.columnTitle")}</th>
                    <th className="dur">{t("library.columnDuration")}</th>
                  </tr>
                </thead>
                <tbody ref={rowsRef}>
                  {feed.episodes.slice(0, shown).map((episode) => (
                    <tr
                      key={episode.audioUrl}
                      className={expanded === episode.audioUrl ? "open" : ""}
                    >
                      <td className="title">
                        {/* `title` is the tooltip a mouse gets for free; the ⋯ beside
                            it is the same thing for a finger, which never hovers. */}
                        <button
                          type="button"
                          className="pick"
                          title={episode.title}
                          disabled={busy || !settings}
                          onClick={() => pick(episode)}
                        >
                          {episode.title}
                        </button>
                        {clipped[episode.audioUrl] && (
                          <button
                            type="button"
                            className="expand"
                            aria-label={t("library.fullTitle")}
                            aria-expanded={expanded === episode.audioUrl}
                            onClick={() =>
                              setExpanded(
                                expanded === episode.audioUrl ? null : episode.audioUrl,
                              )
                            }
                          >
                            ⋯
                          </button>
                        )}
                        {episode.publishedAt && (
                          <span className="when">{episode.publishedAt.slice(0, 10)}</span>
                        )}
                      </td>
                      <td className="dur">
                        {episode.durationSec ? formatTime(episode.durationSec) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown < feed.episodes.length && <div ref={sentinelRef} />}
            </div>
          </>
        )}
        {failure && <p className="text">{t("library.feedFailed", { reason: failure })}</p>}
        <div className="actions">
          {/* One button, and while the feed is in flight it is the way to call it off.
              Closing is what aborts, so the two are the same button and cannot drift. */}
          <button type="button" className="ghost" onClick={dismiss}>
            {busy ? t("common.cancel") : t("common.close")}
          </button>
        </div>
      </dialog>
    </section>
  );
}
