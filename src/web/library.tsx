// The Library screen: what the reader was in the middle of, the shelf, the export that
// is the only thing standing between a Transcript and an evicted browser, and the
// reader's Favorites and the day's recommendations under the one box that both searches
// them and opens a pasted feed.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  slotConfigured,
  type Episode,
  type Favorite,
  type ImportPhase,
  type LanguageCode,
  type Resource,
  type Settings,
} from "../shared/model.ts";
import { backupFilename, buildBackup, parseBackup, planImport } from "./backup.ts";
import { Cover } from "./cover.tsx";
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
import { createPodcastFeed, type FeedListing } from "./podcast-feed.ts";
import { proxyUrl } from "./proxy.ts";
import {
  allEntries,
  listFavorites,
  listResources,
  readSettings,
  remove as removeResource,
  removeFavorite,
  saveFavorite,
} from "./store.ts";

/** The phase names double as i18n keys, so there is no second list to keep in step. */
const phaseKey = (phase: ImportPhase) => `phase.${phase}` as const;

/**
 * How many episodes of a feed to render at a time. A weekly show that has been running
 * five years answers with several hundred, and mounting all of them is a stall on the
 * click that opens the picker. The feed is parsed once and held whole — this is a
 * display cap, not a second request, so the rest costs nothing but the rows.
 */
const PAGE = 20;

/** The search box, by id, so the top bar's search button can hand it focus. */
const SEARCH_ID = "discover-search";

/**
 * Past this much of an episode it counts as heard, and stops being offered as
 * something to continue: the last few percent of a podcast is its sign-off music.
 */
const FINISHED = 0.97;

/** mm:ss, or h:mm:ss past the hour — podcast episodes routinely run longer. */
const formatTime = (seconds: number) =>
  new Date(Math.max(0, seconds) * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/** How far through an episode the reader is, from 0 to 1. */
function heardOf(resource: Resource): number {
  return resource.durationSec > 0
    ? Math.min(1, (resource.lastPositionSec ?? 0) / resource.durationSec)
    : 0;
}

/**
 * Stored audio is the real answer, whatever the phase says: an import that downloaded
 * an episode and then failed to transcribe it left something that plays, and refusing
 * to open it would be withholding bytes we already have. The two phases beside it are
 * for Resources with no `hasAudio` — `ready` from before the field existed or restored
 * from a backup, and `annotating` from the old pipeline, which no import enters any
 * more (ADR 0011).
 */
const isPlayable = (resource: Resource, phase: ImportPhase) =>
  Boolean(resource.hasAudio) || phase === "ready" || phase === "annotating";

export function LibraryScreen() {
  const [resources, setResources] = useState<Resource[] | null>(null);
  /** Undefined until the store has answered, which is not null: nothing stored. */
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  /** Null until the store has answered. */
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const [running, setRunning] = useState<Record<string, ImportProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** A feed the recommendations or the search box sent over, for the picker to open. */
  const [handed, setHanded] = useState("");
  const t = useT();
  const languageOf = useLanguageName();

  const refresh = () =>
    listResources().then(setResources, (failure: unknown) => setError(reason(failure)));

  // A read that fails still settles the state, as none, so the recommendations waiting
  // on both reads still get to choose a chip.
  const refreshFavorites = () =>
    listFavorites().then(setFavorites, (failure: unknown) => {
      setFavorites((current) => current ?? []);
      setError(reason(failure));
    });

  useEffect(() => {
    void refresh();
    void refreshFavorites();
    readSettings().then(
      (loaded) => setSettings(loaded ?? null),
      (failure: unknown) => {
        setSettings(null);
        setError(reason(failure));
      },
    );
  }, []);

  /** Stars the show, or takes its star back: the picker has one button for both. */
  async function toggleFavorite(favorite: Favorite) {
    try {
      if (favorites?.some((kept) => kept.feedUrl === favorite.feedUrl)) {
        await removeFavorite(favorite.feedUrl);
      } else {
        await saveFavorite(favorite);
      }
    } catch (failure) {
      setError(reason(failure));
    }
    void refreshFavorites();
  }

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

  const pairOf = (resource: Resource) =>
    `${
      resource.targetLanguage ? languageOf(resource.targetLanguage) : t("library.autoLanguage")
    } → ${languageOf(resource.nativeLanguage)}`;

  // The episode most recently listened to and not yet finished. By when it was last
  // played rather than by where it sits on the shelf, which stays in import order: a
  // list that reshuffled itself whenever something was played would never be where
  // the reader left it.
  const resume = resources
    ?.filter((resource) => {
      const heard = heardOf(resource);
      return (
        resource.lastPlayedAt &&
        isPlayable(resource, resource.phase) &&
        heard > 0 &&
        heard < FINISHED
      );
    })
    .sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""))[0];

  return (
    <>
      <header className="topbar library-bar">
        <a
          href="#/"
          className="brand"
          onClick={(event) => {
            // This href points where the reader already is, so the click would do
            // nothing at all — no hash change, no re-render. A reload is what it means
            // here, and the shelf is the one screen where one costs nothing: there is
            // no playback to lose and no form half filled in.
            event.preventDefault();
            location.reload();
          }}
        >
          {/* The file the favicon already points at, rather than a second drawing of
              the same mark in SVG — two of them drift. The path is relative for the
              reason the manifest's are: hash routing never changes the document's
              path, so it resolves at the app root wherever the bundle is unpacked.
              Decorative, because the name is written beside it. */}
          <img src="icon-192.png" alt="" width={24} height={24} />
          <span>Duolistening</span>
        </a>
        <button
          type="button"
          className="icon-button"
          aria-label={t("nav.search")}
          title={t("nav.search")}
          onClick={() => document.getElementById(SEARCH_ID)?.focus()}
        >
          <Icon name="search" />
        </button>
        <a
          href="#/settings"
          className="icon-button"
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <Icon name="gear" />
        </a>
      </header>

      <main className="library">
        {error && <p className="error">{error}</p>}

        {resume && (
          <section className="resume" aria-labelledby="resume-title">
            <h2 id="resume-title">{t("library.continue")}</h2>
            <a className="resume-card" href={`#/r/${encodeURIComponent(resume.id)}`}>
              <Cover src={resume.artworkUrl} name={resume.showTitle ?? resume.title} />
              <span className="row-body">
                <span className="title">{resume.title}</span>
                <span className="meta">
                  {[
                    t("library.left", {
                      time: formatTime(resume.durationSec - (resume.lastPositionSec ?? 0)),
                    }),
                    resume.showTitle,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="listened" aria-hidden="true">
                  <i style={{ width: `${heardOf(resume) * 100}%` }} />
                </span>
              </span>
              <span className="resume-play" aria-hidden="true">
                <Icon name="play" />
              </span>
            </a>
          </section>
        )}

        <section className="shelf-section" aria-labelledby="shelf-title">
          <div className="section-head">
            <h2 id="shelf-title">
              {t("nav.library")}
              {resources?.length ? <span className="count">{resources.length}</span> : null}
            </h2>
            <Backup
              resources={resources}
              favorites={favorites}
              onImported={() => {
                void refresh();
                void refreshFavorites();
              }}
              onError={setError}
            />
          </div>

          {resources === null ? (
            <p className="notice">{t("common.loading")}</p>
          ) : resources.length === 0 ? (
            <Welcome settings={settings ?? null} />
          ) : (
            <ul className="shelf">
              {resources.map((resource) => {
                const live = running[resource.id];
                const phase = live?.phase ?? resource.phase;
                const progress = live?.progress;
                const failureReason = resource.failureReason;
                // Failed, or left in a running phase by a reload that took its import
                // with it. Both need the same way out — and neither is true of an import
                // that is running right now, which is why this asks `import.ts` rather
                // than a Set of its own: this screen never knew about a transcription
                // started from the player, and offered a Resume that billed the episode
                // a second time.
                const stalled = phase !== "ready" && !isImporting(resource.id);
                const playable = isPlayable(resource, phase);
                const heard = heardOf(resource);
                return (
                  <li key={resource.id} className={playable ? "ready" : undefined}>
                    <a
                      className="row"
                      href={playable ? `#/r/${encodeURIComponent(resource.id)}` : undefined}
                    >
                      <Cover
                        src={resource.artworkUrl}
                        name={resource.showTitle ?? resource.title}
                      />
                      <span className="row-body">
                        <span className="title">{resource.title}</span>
                        <span className="meta">
                          {[
                            formatTime(resource.durationSec),
                            pairOf(resource),
                            resource.showTitle,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {phase !== "ready" ? (
                          <span className={`phase ${phase}`}>
                            {t(phaseKey(phase))}
                            {progress !== undefined && ` ${Math.round(progress * 100)}%`}
                            {failureReason && `: ${failureReason}`}
                          </span>
                        ) : heard > 0 ? (
                          <span className="heard">
                            {heard >= FINISHED
                              ? t("library.finished")
                              : t("library.left", {
                                  time: formatTime(
                                    resource.durationSec - (resource.lastPositionSec ?? 0),
                                  ),
                                })}
                          </span>
                        ) : null}
                        {/* An import runs for minutes, and a percentage only reads once you
                            stop to read it. A bar reads while scrolling past — and so does
                            how far through an episode someone already is. */}
                        {progress !== undefined && phase !== "ready" ? (
                          <progress value={progress} max={1} />
                        ) : phase === "ready" && heard > 0 && heard < FINISHED ? (
                          <span className="listened" aria-hidden="true">
                            <i style={{ width: `${heard * 100}%` }} />
                          </span>
                        ) : null}
                      </span>
                    </a>
                    {stalled && (
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void retry(resource)}
                      >
                        {phase === "failed" ? t("library.retry") : t("library.resumeImport")}
                      </button>
                    )}
                    {/* Two clicks rather than confirm(): that dialog blocks the page,
                        cannot be styled to match either theme, and reads as a browser
                        error. The second click is deliberately not in the same place as
                        the first. Delete sits at the end of the row, so arming puts
                        Cancel there — under whatever just clicked Delete — and Confirm to
                        its left, where nothing has been clicked yet. A double-click, the
                        mis-operation this is actually guarding against, therefore lands
                        on Cancel. Cancel also takes focus, so a reflexive Enter goes the
                        same safe way. */}
                    {confirming === resource.id ? (
                      // One blur handler for the pair, not one each: focus moving from
                      // Cancel to Confirm is still focus inside the confirmation, and
                      // disarming on it would make the pair impossible to reach with a
                      // keyboard.
                      <span
                        className="confirm"
                        onBlur={(event) => {
                          // A null `relatedTarget` is focus going nowhere, and that is what
                          // a plain click on a button reports in WebKit — it blurs whatever
                          // had focus and focuses nothing. Treating it as focus leaving
                          // unmounted Confirm between mousedown and mouseup, so the click
                          // never reached it and the episode stayed on the shelf. Only a
                          // move to another element disarms; an armed pair otherwise waits
                          // for Cancel, Confirm, or the next Delete.
                          if (
                            event.relatedTarget &&
                            !event.currentTarget.contains(event.relatedTarget)
                          )
                            setConfirming(null);
                        }}
                      >
                        <button
                          type="button"
                          className="ghost danger"
                          onClick={() => void remove(resource)}
                        >
                          {t("common.confirm")}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          autoFocus
                          onClick={() => setConfirming(null)}
                        >
                          {t("common.cancel")}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="icon-button delete"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={() => setConfirming(resource.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Under the shelf, not above it. A reader with episodes came back for those;
            a reader without any has an empty shelf and this is what fills the screen. */}
        <Recommended onPick={setHanded} settings={settings} favorites={favorites} />

        <EpisodePicker
          settings={settings ?? null}
          favorites={favorites}
          onToggleFavorite={(favorite) => void toggleFavorite(favorite)}
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
      </main>
    </>
  );
}

/**
 * What an empty shelf says instead of "nothing here": the three things that stand
 * between a first visit and a first episode, each ticked off once it is true. The
 * deployment is public, so whoever reads this has usually configured nothing at all.
 */
function Welcome({ settings }: { settings: Settings | null }) {
  const t = useT();
  const steps = [
    { done: Boolean(settings?.proxy?.baseUrl.trim()), text: t("onboard.proxy") },
    { done: slotConfigured(settings?.transcriptionModel), text: t("onboard.transcribe") },
    // Never ticked: an empty shelf is exactly what this step being undone looks like.
    { done: false, text: t("onboard.pick") },
  ];
  return (
    <div className="welcome">
      <h3>{t("onboard.title")}</h3>
      <ol className="steps">
        {steps.map((step, index) => (
          <li key={index} className={step.done ? "done" : undefined}>
            <span className="step-mark" aria-hidden="true">
              {step.done ? <Icon name="check" size={0.9} /> : index + 1}
            </span>
            <span className="step-text">
              {step.text}
              {step.done && <span className="visually-hidden"> ({t("onboard.done")})</span>}
            </span>
            {index === 0 && !step.done && (
              <a href="#/settings" className="button primary small">
                {t("nav.settings")}
              </a>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Remembered so the day's one request can happen without asking again every visit. */
const DISCOVER_KEY = "duolistening.discover";

/** The chip that shows the reader's Favorites instead of a language's recommendations. */
const FAVORITES = "favorites";

/**
 * The order the language chips are drawn in, which is not `LANGUAGES`' order. A rank per
 * language rather than a list, so a language added there and forgotten here is a type
 * error instead of a chip that silently never appears.
 */
const CHIP_RANK: Record<LanguageCode, number> = {
  en: 0,
  ja: 1,
  ko: 2,
  de: 3,
  fr: 4,
  es: 5,
  "zh-CN": 6,
  "zh-TW": 7,
};
const CHIP_LANGUAGES = [...LANGUAGES].sort((a, b) => CHIP_RANK[a] - CHIP_RANK[b]);

/**
 * The reader's Favorites and the day's recommendations, and the box above them.
 *
 * Apple's top-charts feed sends no CORS headers and cannot be read from a page at
 * all, so "what is popular" is approximated by what a storefront answers for that
 * language's own search terms — which for someone studying the language is the better
 * list anyway, and it arrives with the `feedUrl` an import needs. `itunes.ts` owns the
 * queries and the once-a-day cache; this only decides which language to ask about.
 *
 * The Favorites are the first chip, and drawn from the store alone: a star is added and
 * taken back in the episode picker, and showing them asks nobody for anything.
 *
 * The box takes either kind of answer to "what do you want to listen to": a word, which
 * searches, or a link, which is a feed to open. It used to be two boxes a screen apart,
 * and which one a pasted link belonged in was a question nobody should have to ask.
 *
 * The network is touched exactly twice a day per language, and once more each time
 * the reader types a search. Nothing else here reaches out.
 */
function Recommended({
  settings,
  favorites,
  onPick,
}: {
  /** Undefined until the store has answered. */
  settings: Settings | null | undefined;
  /** Null until the store has answered. */
  favorites: Favorite[] | null;
  onPick: (feedUrl: string) => void;
}) {
  const t = useT();
  const languageOf = useLanguageName();
  /** A language, or the Favorites. Null only until both reads above are in. */
  const [chosen, setChosen] = useState<LanguageCode | typeof FAVORITES | null>(null);
  const [items, setItems] = useState<PodcastSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [term, setTerm] = useState("");
  /** The term the list on screen answers, when it answers a search rather than the day. */
  const [searched, setSearched] = useState<string | null>(null);
  // Bumped by the ✕ to re-run the effect below without a second copy of what it
  // does: the language has not changed, so nothing else would tell it to.
  const [refresh, setRefresh] = useState(0);

  // Which chip a visit opens on, decided once and only when both reads are in: the
  // Favorites when there are any, else what the reader said they are studying, else the
  // language they last picked here, else English. Deciding on the settings alone would
  // draw a language's list — and ask Apple for it — a moment before the Favorites
  // replaced it. Once decided it stays put: starring a first show, or taking the last
  // star away, leaves the reader on the chip they are looking at.
  useEffect(() => {
    if (settings === undefined || favorites === null) return;
    setChosen(
      (current) =>
        current ??
        (favorites.length > 0 ? FAVORITES : (settings?.targetLanguage ?? stored() ?? "en")),
    );
  }, [settings, favorites]);

  useEffect(() => {
    setFailed(false);
    if (!chosen || chosen === FAVORITES) return;
    setBusy(true);
    recommendedFor(chosen)
      .then(setItems, () => setFailed(true))
      .finally(() => setBusy(false));
  }, [chosen, refresh]);

  // Back to the day's list: the cache in itunes.ts means this is free in the normal
  // case, same as picking a language chip is.
  function clearSearch() {
    setTerm("");
    setSearched(null);
    setItems(null);
    setRefresh((generation) => generation + 1);
  }

  function choose(code: LanguageCode) {
    // Through clearSearch, so the chip already showing as chosen still reloads. Its
    // own setChosen is a no-op in that case, the effect's deps never change, and
    // the list it just emptied would stay empty for as long as the screen is open.
    clearSearch();
    setChosen(code);
    try {
      localStorage.setItem(DISCOVER_KEY, code);
    } catch {
      // Private mode. The chip still works for this visit, which is all it owes.
    }
  }

  // Not remembered: the stored key is the language last asked about, and with any
  // Favorites at all a visit opens on them anyway.
  function chooseFavorites() {
    clearSearch();
    setChosen(FAVORITES);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const wanted = term.trim();
    if (!wanted) return;
    // A link is a feed to open, not a phrase to look for. The box keeps it, so a link
    // whose feed would not load is still there to correct.
    if (/^https?:\/\//i.test(wanted)) return onPick(wanted);

    setBusy(true);
    setFailed(false);
    try {
      // Deliberately past the cache: a search is the reader asking for something the
      // day's list did not have. With the Favorites on screen the storefront is the one
      // for what the reader studies; with no language at all there is none to prefer,
      // and the US one holds the widest catalogue.
      const market = chosen && chosen !== FAVORITES ? chosen : settings?.targetLanguage;
      setItems(
        await searchPodcasts({
          term: wanted,
          country: market ? MARKETS[market].country : "US",
        }),
      );
      setSearched(wanted);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const showingFavorites = chosen === FAVORITES && !searched;
  // Both lists draw the same tile. A Favorite has no genres, so it never has the badge.
  const tiles = showingFavorites
    ? (favorites ?? []).map((favorite) => ({
        ...favorite,
        key: favorite.feedUrl,
        learning: false,
      }))
    : (items ?? []).map((suggestion) => ({
        ...suggestion,
        key: String(suggestion.collectionId),
        learning: suggestion.genreIds.includes(LANGUAGE_LEARNING_GENRE),
      }));

  return (
    <section className="discover" aria-labelledby="discover-title">
      <div className="section-head">
        <h2 id="discover-title">{t("discover.title")}</h2>
      </div>
      <p className="hint">
        {showingFavorites ? t("discover.favoritesSubtitle") : t("discover.subtitle")}
      </p>

      <form className="search-field" role="search" onSubmit={(event) => void submit(event)}>
        <Icon name="search" />
        <input
          id={SEARCH_ID}
          value={term}
          placeholder={t("discover.searchPlaceholder")}
          aria-label={t("nav.search")}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setTerm(event.target.value)}
        />
        {term && (
          <button
            type="button"
            className="clear"
            aria-label={t("discover.clearSearch")}
            onClick={clearSearch}
          >
            <Icon name="close" size={0.95} />
          </button>
        )}
      </form>

      <div className="chips">
        <button
          type="button"
          className={showingFavorites ? "chip on" : "chip"}
          aria-pressed={showingFavorites}
          onClick={chooseFavorites}
        >
          <Icon name="star" />
          <span>{t("discover.favorites")}</span>
        </button>
        {CHIP_LANGUAGES.map((code) => (
          <button
            key={code}
            type="button"
            className={code === chosen && !searched ? "chip on" : "chip"}
            aria-pressed={code === chosen && !searched}
            onClick={() => choose(code)}
          >
            {languageOf(code)}
          </button>
        ))}
      </div>

      {searched && <p className="results-for">{t("discover.results", { term: searched })}</p>}
      {busy && <p className="notice">{t("discover.loading")}</p>}
      {failed && <p className="error">{t("discover.failed")}</p>}
      {showingFavorites
        ? favorites?.length === 0 && <p className="notice">{t("discover.noFavorites")}</p>
        : items?.length === 0 && !busy && <p className="notice">{t("discover.empty")}</p>}

      <ul className="suggestions">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <button type="button" className="suggestion" onClick={() => onPick(tile.feedUrl)}>
              {/* Straight from the host — Apple's CDN for a Suggestion, the feed's own for
                  a Favorite — which needs no proxy for an image element and no key. The
                  cost is one outbound request per card and a monogram offline, which is
                  why nothing but the artwork depends on it. */}
              <Cover src={tile.artworkUrl} name={tile.title} />
              <span className="title">{tile.title}</span>
              {tile.author && <span className="author">{tile.author}</span>}
              {tile.learning && <span className="badge">{t("discover.languageLearning")}</span>}
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
  favorites,
  onImported,
  onError,
}: {
  resources: Resource[] | null;
  favorites: Favorite[] | null;
  onImported: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const t = useT();

  async function save() {
    try {
      const { backup } = buildBackup({
        entries: await allEntries(),
        favorites: await listFavorites(),
      });
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
    const plan = planImport(have, parsed.backup, {
      favorited: (favorites ?? []).map((favorite) => favorite.feedUrl),
    });
    const { save: saveEntry } = await import("./store.ts");
    for (const entry of plan.add) {
      await saveEntry({ resource: entry.resource, transcript: entry.transcript });
    }
    for (const favorite of plan.favorites) await saveFavorite(favorite);
    setStatus(
      t("library.imported", { added: plan.add.length, skipped: plan.alreadyHere.length }),
    );
    onImported();
  }

  return (
    <div className="backup">
      {/* Restore is offered on an empty shelf, which is exactly the shelf a new device
          or an evicted browser has; Export is not, having nothing to write — unless
          there are Favorites, which are worth carrying to another device on their own. */}
      {resources?.length || favorites?.length ? (
        <button type="button" className="ghost small" onClick={() => void save()}>
          <Icon name="download" />
          <span>{t("library.exportBackup")}</span>
        </button>
      ) : null}
      <button type="button" className="ghost small" onClick={() => file.current?.click()}>
        <Icon name="upload" />
        <span>{t("library.importBackup")}</span>
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
    </div>
  );
}

/**
 * The episode picker: a feed's episodes, in a dialog, for the reader to choose one to
 * import. Whatever sent the feed — a recommendation or a link in the search box — hands
 * it over as `handed`; this owns the request, the list and the import it starts.
 */
function EpisodePicker({
  settings,
  favorites,
  onToggleFavorite,
  handed,
  onHandled,
  onStart,
  onError,
}: {
  settings: Settings | null;
  favorites: Favorite[] | null;
  /** Stars the listed show, or takes its star back. */
  onToggleFavorite: (favorite: Favorite) => void;
  /** A feed URL to open, or "" for nothing pending. */
  handed: string;
  onHandled: () => void;
  onStart: (
    id: string,
    begin: (report: (p: ImportProgress) => void) => Promise<unknown>,
  ) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<FeedListing | null>(null);
  /** Which feed the dialog is showing. */
  const [listed, setListed] = useState("");
  /** Why the list could not be fetched — shown in the dialog the list would have been. */
  const [failure, setFailure] = useState<string | null>(null);
  /** How much of the parsed feed is on screen. Reset with every feed, or the second
      show opens already scrolled past its own first ten episodes. */
  const [shown, setShown] = useState(PAGE);
  /** The one episode showing its title in full, by `audioUrl`. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Which titles the column actually cut, by `audioUrl`. Only those get an expander. */
  const [clipped, setClipped] = useState<Record<string, boolean>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** The feed request in flight, so the dialog's Cancel can drop it. */
  const fetching = useRef<AbortController | null>(null);
  const rowsRef = useRef<HTMLTableSectionElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const t = useT();
  /** Whether the show on screen is starred — by the feed URL it was opened with. */
  const favorited = Boolean(favorites?.some((kept) => kept.feedUrl === listed));

  // A feed, opened in the one episode picker this screen has. Cleared as soon as it is
  // taken, so picking the same show again after importing from it is not a dead click.
  // Nothing is scrolled into view: the picker is a modal, and it opens where the
  // reader is already looking.
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
  // therefore "fits" — does not lose the expander that expanded it. The ceiling is a
  // window resized while the list is open: those rows keep the answer they were given.
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

  function pick(episode: Episode, listing: FeedListing) {
    if (!settings) return;
    // The id is decided here rather than inside the import, so progress and the "is
    // this tab driving it" check are keyed by the Resource from the first tick. Keying
    // them by anything else leaves the shelf showing a Resume button beside a running
    // import.
    const id = crypto.randomUUID();
    const deps = { ...buildImportDeps(settings), newId: () => id };
    const artworkUrl = episode.artworkUrl ?? listing.artworkUrl;
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
          showTitle: listing.feedTitle,
          ...(artworkUrl && { artworkUrl }),
          ...(episode.durationSec && { durationSec: episode.durationSec }),
        },
        report,
      ),
    );
    dismiss();
    setFeed(null);
  }

  return (
    // One dialog for both answers a feed can give. A modal rather than a block that
    // pushes the shelf down: a feed's episodes are a decision to make now, and the list
    // used to appear above a screen the reader was already scrolled past.
    //
    // `onClose` for Esc, and the button below calls the same function rather than
    // leaving it to the event this raises: a hidden page never delivers a dialog's
    // `close`, so that route cannot be measured, and the one a finger takes should not
    // be the unmeasurable one. `close()` on a closed dialog raises nothing, so arriving
    // both ways costs one no-op.
    <dialog ref={dialogRef} className="sheet picker-sheet" onClose={dismiss}>
      {/* The wait, in the dialog the list will appear in — not an overlay of its own,
          which would be a second mask over the one a modal already draws. An
          indeterminate <progress> because there is no fraction to report: a feed
          arrives whole or not at all. */}
      {busy && (
        <>
          <p className="sheet-title">{t("library.working")}</p>
          <progress />
        </>
      )}
      {feed && (
        <>
          <div className="picker-head">
            <Cover src={feed.artworkUrl} name={feed.feedTitle} />
            <div>
              <p className="sheet-title">{feed.feedTitle}</p>
              <p className="note">{t("library.pickEpisode")}</p>
            </div>
            <button
              type="button"
              className="secondary small favorite"
              onClick={() =>
                onToggleFavorite({
                  feedUrl: listed,
                  title: feed.feedTitle,
                  ...(feed.author && { author: feed.author }),
                  ...(feed.artworkUrl && { artworkUrl: feed.artworkUrl }),
                  addedAt: new Date().toISOString(),
                })
              }
            >
              {/* Both faces are laid out and one is drawn, so the button is as wide as the
                  wider of them in every language, and the show's name beside it never
                  re-wraps on a click. Each face's icon and label say what a click does. */}
              <span aria-hidden={favorited}>
                <Icon name="star" />
                {t("library.favorite")}
              </span>
              <span aria-hidden={!favorited}>
                <Icon name="star-off" />
                {t("library.unfavorite")}
              </span>
            </button>
          </div>
          {/* The scroll is here and not on the dialog, so the show's name, the header
              row and the buttons stay put while three hundred episodes move. */}
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
                    className={expanded === episode.audioUrl ? "open" : undefined}
                  >
                    <td className="title">
                      {/* `title` is the tooltip a mouse gets for free; the expander
                          beside it is the same thing for a finger, which never hovers. */}
                      <button
                        type="button"
                        className="pick"
                        title={episode.title}
                        disabled={busy || !settings}
                        onClick={() => pick(episode, feed)}
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
                            setExpanded(expanded === episode.audioUrl ? null : episode.audioUrl)
                          }
                        >
                          <Icon name="chevron-down" size={0.95} />
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
      {failure && <p className="sheet-title">{t("library.feedFailed", { reason: failure })}</p>}
      <div className="actions">
        {/* One button, and while the feed is in flight it is the way to call it off.
            Closing is what aborts, so the two are the same button and cannot drift. */}
        <button type="button" className="secondary" onClick={dismiss}>
          {busy ? t("common.cancel") : t("common.close")}
        </button>
      </div>
    </dialog>
  );
}
