// The lyrics view: an <audio> element, a Transcript that follows it, and the ask-AI
// popup. Everything about "which Line is playing" comes from shared/locate.ts, which
// is pure and already tested — this file only turns its answer into DOM.
//
// One DOM for both looks (ADR 0016). Standard lays it out as a lyric page with the cover
// beside it, Station as a timetable; the markup carries what either of them needs —
// each Line's start time, the stops either side of the current one, a tick per Line
// along the band — and the stylesheet alone decides which of it is shown.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StringKey } from "../shared/i18n.ts";
import {
  JAPANESE,
  type Line,
  type Resource,
  type Settings,
  slotConfigured,
  type Token,
  type Transcript,
} from "../shared/model.ts";
import { type Position, locate, sweepState, tokenWords, wordSlices } from "../shared/locate.ts";
import { BLOCK_LINES, nextWindow, wantsJapanese } from "./annotate.ts";
import { Cover, LineBadge } from "./cover.tsx";
import { Icon } from "./icons.tsx";
import { isImporting, retryImport, type ImportProgress } from "./import.ts";
import { buildAnnotator, buildImportDeps, japaneseTokenizer } from "./pipeline.ts";
import { proxyUrl } from "./proxy.ts";
import {
  flushPosition,
  getAudio,
  getResource,
  getTranscript,
  readSettings,
  savePosition,
  saveTranscript,
} from "./store.ts";
import { useLanguageName, useT } from "./i18n.ts";
import { createTextModel } from "./text-model.ts";

/** What the screen plays: the shelf entry, its Lines, and something `<audio>` accepts. */
interface PlayableResource {
  resource: Resource;
  transcript: Transcript;
  /**
   * A blob URL over the stored audio, or the proxy standing in for it when there is
   * none — which is what a Resource restored from a backup looks like, since a backup
   * carries Transcripts and not audio.
   */
  audioUrl: string;
}

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/** mm:ss, or h:mm:ss past the hour — podcast episodes routinely run longer. */
const formatTime = (seconds: number) =>
  new Date(Math.max(0, seconds) * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);

/**
 * The speeds on offer: finely stepped at the slow end, because this is a listening tool
 * and 0.85× is a real choice there, and coarse at the fast end, where nobody studies.
 */
const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "duolistening.rate";

/** A rate kept from the old 0.05-step slider can fall between two stops; it stays on offer. */
const rateChoices = (rate: number) =>
  RATES.includes(rate) ? RATES : [...RATES, rate].sort((a, b) => a - b);

/** "1.0×" and "0.85×" — one decimal where one says it, never "1.10×". */
const formatRate = (rate: number) =>
  `${rate.toFixed(Math.round(rate * 100) % 10 === 0 ? 1 : 2)}×`;

/**
 * What the Lines show. `none` is listening blind: every Line is blurred until it is
 * chosen, and choosing one replays it and shows it — listen first, then check.
 */
const MODES = ["both", "text", "none"] as const;
type SubtitleMode = (typeof MODES)[number];
const MODE_KEY = "duolistening.subtitles";
const MODE_LABELS: Record<SubtitleMode, StringKey> = {
  both: "player.showBoth",
  text: "player.showText",
  none: "player.showNone",
};

/**
 * A tick per Line along the Station look's band, up to this many. Past it the ticks sit
 * closer together than a pixel on a phone and stop saying where anything is — an
 * 828-Line episode would draw a grey bar the hard way.
 */
const MAX_TICKS = 150;

/**
 * How long playback has to rest in a block before the window around it goes out. The
 * translation effect re-runs whenever the block changes, and a drag along the progress
 * bar changes it every few pixels: without the wait, the first block a drag crossed was
 * translated for nobody.
 */
const SETTLE_MS = 1000;

/**
 * The translation window in flight for each episode — for the page, not for one visit to
 * this screen. An answer outlives the screen that asked for it, since it is written to
 * the store wherever the reader has gone, and pressing Back and opening the episode
 * again while one was out used to send the same window a second time beside the first.
 */
const windowsInFlight = new Map<Resource["id"], Promise<void>>();

/** Native list-scrolling keys. Arrow-left/right are deliberately not here: those are
    the app's own line shortcuts below, and a jump they cause should still be followed. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

const NOWHERE: Position = { lineIndex: -1, wordIndex: null };

/** Playback speed is a habit, not a per-episode choice, so it outlives the page. */
function storedRate(): number {
  const stored = Number(localStorage.getItem(RATE_KEY));
  return stored >= 0.5 && stored <= 2 ? stored : 1;
}

/** So is how much of the Transcript someone wants to see while they listen. */
function storedMode(): SubtitleMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.includes(stored as SubtitleMode) ? (stored as SubtitleMode) : "both";
  } catch {
    return "both";
  }
}

/**
 * How much of the bar lies behind the playhead, as a custom property the track's
 * gradient reads. A range input has no filled half of its own in WebKit, and a second
 * element laid over it would be one more thing to keep in step with the thumb.
 */
function paintPlayed(input: HTMLInputElement) {
  const max = Number(input.max) || 1;
  input.style.setProperty("--played", `${Math.min(100, (Number(input.value) / max) * 100)}%`);
}

export function PlayerScreen({ id }: { id: string }) {
  const [data, setData] = useState<PlayableResource | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>(NOWHERE);
  const [asking, setAsking] = useState<string | null>(null);
  const t = useT();
  const languageOf = useLanguageName();
  const [rate, setRate] = useState(storedRate);
  const [mode, setMode] = useState(storedMode);
  /** Lines chosen while the mode is `none` — the ones shown despite it. */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  // On by default; a user scroll turns it off and it stays off, no timer. The only
  // way back is the floating control, once the reader wants to be found again.
  const [following, setFollowing] = useState(true);
  const [loop, setLoop] = useState(false);
  // Two facts the drawn transport needs that the native controls used to own. Both
  // change a handful of times per episode, unlike the playhead below.
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  /** Non-null while this screen is running the transcription it offers below. */
  const [retrying, setRetrying] = useState<ImportProgress | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /**
   * The progress bar and the two clocks beside it, written to directly.
   *
   * The playhead moves sixty times a second and nothing else on the screen depends on
   * it — putting it in state would re-render every Line in the Transcript on every
   * frame, which is exactly what the sampler below is careful not to do for the Word
   * highlight. So these three are set imperatively from the same frame, and React
   * never learns the number.
   */
  const scrubRef = useRef<HTMLInputElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  /** Held down on the progress bar: the frame loop must stop writing over the drag. */
  const scrubbing = useRef(false);

  /**
   * The playhead, painted straight into the DOM. Reads the element rather than state
   * so it cannot go stale, and leaves the bar alone while a finger is on it.
   */
  const paintTransport = (audio: HTMLAudioElement) => {
    const total = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (elapsedRef.current) elapsedRef.current.textContent = formatTime(audio.currentTime);
    if (remainingRef.current)
      remainingRef.current.textContent = total
        ? `-${formatTime(total - audio.currentTime)}`
        : "";
    if (scrubRef.current && !scrubbing.current) {
      scrubRef.current.value = String(audio.currentTime);
      paintPlayed(scrubRef.current);
    }
  };

  /**
   * Playback moved by whole Lines, which is the unit this app is about — not by ±15
   * seconds, the way a podcast app would. The arrow keys, the transport's buttons and
   * the lock screen's track buttons are three ways into this one function; a `delta`
   * of 0 replays the Line being listened to.
   */
  const jump = (delta: number) => {
    const audio = audioRef.current;
    const lines = data?.transcript;
    if (!audio || !lines?.length) return;
    const here = locate(lines, audio.currentTime).lineIndex;
    const index = Math.max(0, Math.min(lines.length - 1, here < 0 ? 0 : here + delta));
    loopLine.current = lines[index]!;
    audio.currentTime = lines[index]!.startSec;
    void audio.play();
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  /**
   * Transcribing an episode that was imported without a model — the shelf's Resume,
   * offered where the missing Lines are. The audio is already stored, so this is the
   * transcription and nothing else; the download is not paid for twice.
   *
   * Two details about `lastPositionSec`, which `store.save` writes as part of the
   * whole Resource row. The Resource is re-read rather than taken from `data`, which
   * has held whatever this screen loaded with since it opened. And the position is
   * written again once the import lands, because the import ran for minutes while
   * something was very likely playing, and its last save put back the position it
   * read at the start.
   */
  async function retryTranscription() {
    if (!settings || retrying) return;
    const before = await getResource(id);
    if (!before) return;

    setRetryError(null);
    setRetrying({ phase: "transcribing" });
    try {
      const after = await retryImport(buildImportDeps(settings), before, setRetrying);
      if (seconds.current > 0) await savePosition(id, seconds.current);
      const transcript = await getTranscript(id);
      setData(
        (current) => current && { ...current, resource: after, transcript: transcript ?? [] },
      );
    } catch (failure) {
      // `run` inside the import turns its own failures into a `failed` Resource, so
      // the only way out here is the guard that refuses to redo a finished episode.
      setRetryError(reason(failure));
    } finally {
      setRetrying(null);
    }
  }
  // The ref, not the audio element: on unmount React may have detached it already,
  // and the last position is the one thing that must survive leaving the screen.
  const seconds = useRef(0);
  // Mirrors `loop` for the sampler effect below, which reads it every frame and must
  // not be torn down and rebuilt each time the toggle is clicked.
  const loopRef = useRef(false);
  // The Line eligible to loop — always whichever one `sample` last landed on, so
  // turning the toggle on mid-line loops whatever is already playing. `seekLine` and
  // `jump` also set this the instant they fire: without that, clicking a later Line
  // while looping would still find the old Line here, see the new time already past
  // its endSec, and yank playback straight back to the Line just left.
  const loopLine = useRef<Line | null>(null);

  useEffect(() => {
    setData(null);
    setPosition(NOWHERE);
    setFollowing(true);
    loopLine.current = null;

    // The blob URL is revoked when this effect is torn down, so switching episodes
    // does not leave the previous one's bytes pinned in memory for the tab's life.
    let revoke: string | undefined;
    let dropped = false;
    (async () => {
      const [resource, transcript, audio, settings] = await Promise.all([
        getResource(id),
        getTranscript(id),
        getAudio(id),
        readSettings(),
      ]);
      if (dropped) return;
      if (!resource) throw new Error(t("player.missing"));

      // Stored audio wins. Falling back to the proxy is for a Resource restored from
      // a backup, which carries Transcripts and not audio — playable, with the caveat
      // that a host splicing advertising may hand back a recording whose timings no
      // longer line up with the Lines made from it.
      const audioUrl = audio
        ? ((revoke = URL.createObjectURL(audio)), revoke)
        : resource.source.kind === "podcast"
          ? proxyUrl(settings?.proxy, resource.source.episodeUrl)
          : "";

      // Where playback is about to be, before <audio> has loaded enough metadata to
      // be moved there. The translation window below reads this, and starting it at
      // zero would translate the opening minutes for someone resuming at twenty.
      seconds.current = resource.lastPositionSec ?? 0;
      setSettings(settings ?? null);
      setData({ resource, transcript: transcript ?? [], audioUrl });
    })().catch((failure: unknown) => {
      if (!dropped) setError(reason(failure));
    });

    return () => {
      dropped = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id, t]);

  // Opened at a deep link while the import is still running — the shelf only links
  // here once there is something to play. Re-read until it lands.
  useEffect(() => {
    const phase = data?.resource.phase;
    // `untranscribed` is a resting state like the other two: the import finished and
    // left audio behind. Polling it would ask the store the same question every two
    // seconds for as long as the screen is open.
    if (!phase || phase === "ready" || phase === "failed" || phase === "untranscribed") return;
    // Polling, where this used to subscribe to the import's own event stream. The
    // import runs in whichever screen started it and publishes nothing, so the store
    // is the only thing both sides share. `audioUrl` is deliberately left out of the
    // merge: replacing it would reset the <audio> element mid-playback.
    const timer = setInterval(async () => {
      const [resource, transcript] = await Promise.all([getResource(id), getTranscript(id)]);
      if (!resource) return;
      setData((current) => current && { ...current, resource, transcript: transcript ?? [] });
    }, 2000);
    return () => clearInterval(timer);
  }, [id, data?.resource.phase]);

  useEffect(
    () => () => {
      if (seconds.current > 0) void savePosition(id, seconds.current);
    },
    [id],
  );

  // Neither the unmount cleanup above nor the pause/seeked saves below run when the
  // tab is closed, the browser quits, or iOS Safari backgrounds the app — pagehide
  // and a visibilitychange to hidden are what's left to catch those.
  //
  // These park the position in localStorage rather than writing it. An IndexedDB
  // transaction opened as the page tears down is not reliably committed, and there
  // is no beacon for IndexedDB the way there was for a POST; localStorage is
  // synchronous, so the write is done before the page can go. The store folds it
  // back in on the next read.
  useEffect(() => {
    const onHide = () => {
      if (seconds.current > 0) flushPosition(id, seconds.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id]);

  // The element is the source of truth for the rate; this only keeps it in step.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
    localStorage.setItem(RATE_KEY, String(rate));
  }, [rate, data]);

  // The mode outlives the page, and changing it hides every Line again: what was
  // revealed was revealed for the mode being left.
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Private mode. The choice holds for this visit, which is all it owes.
    }
    setRevealed(new Set());
  }, [mode]);

  // Mirrors `loop` for the sampler effect below, which reads it every frame and must
  // not be torn down and rebuilt each time the toggle is clicked.
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  /**
   * Follows playback frame by frame — `timeupdate` fires about four times a second,
   * too coarse for word-level highlight. Cheap despite that: state only changes when
   * the Line or Word actually changes, so a long Transcript re-renders rarely.
   */
  useEffect(() => {
    const audio = audioRef.current;
    const lines = data?.transcript;
    if (!audio || !lines) return;

    let frame = 0;
    const sample = () => {
      // Checked against the Line `sample` landed on last time, not the one about to
      // be computed below: back-to-back Lines share a boundary, so the instant
      // currentTime passes this one's endSec is the same instant locate() would
      // already call the next Line current. Checking the stale side of that instant
      // first is what makes the loop land on the Line that just ended, not the next.
      const looping = loopRef.current ? loopLine.current : null;
      if (looping && audio.currentTime >= looping.endSec) audio.currentTime = looping.startSec;

      seconds.current = audio.currentTime;
      paintTransport(audio);
      const next = locate(lines, audio.currentTime);
      loopLine.current = next.lineIndex < 0 ? null : (lines[next.lineIndex] ?? null);
      setPosition((previous) =>
        previous.lineIndex === next.lineIndex && previous.wordIndex === next.wordIndex
          ? previous
          : next,
      );
    };
    const tick = () => {
      sample();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      setPlaying(true);
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      frame = 0;
      sample();
      if (seconds.current > 0) void savePosition(id, seconds.current);
    };
    // The element's own duration wins over the Resource's: a Transcript restored from
    // a backup plays through the proxy, and what the origin serves today is what the
    // progress bar has to measure against.
    const measure = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      paintTransport(audio);
    };

    // The saved position rides on timeupdate, not on the frame loop above:
    // requestAnimationFrame is suspended in a hidden tab while the audio keeps
    // playing, so a listener who switches tabs, listens on, and then closes the page
    // would be rewound to wherever they switched away. timeupdate keeps firing there,
    // and its four-times-a-second is coarse only for highlighting, never for a resume
    // point. React detaches audioRef before this component's unmount cleanup runs, so
    // reading the element at save time is not an option — the ref has to be current.
    const mark = () => {
      seconds.current = audio.currentTime;
    };

    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    // `ended` does not imply `pause`, so without this the drawn button would still
    // read as playing after the last Line.
    audio.addEventListener("ended", stop);
    audio.addEventListener("seeked", sample);
    audio.addEventListener("timeupdate", mark);
    audio.addEventListener("durationchange", measure);
    measure();
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
      audio.removeEventListener("seeked", sample);
      audio.removeEventListener("timeupdate", mark);
      audio.removeEventListener("durationchange", measure);
    };
  }, [data, id]);

  // ---------------------------------------------------------------- annotation

  /**
   * One per Settings, not one per window.
   *
   * Null when no Text Model is configured, and the translation effect then does
   * nothing at all — a Transcript restored from a backup still shows its Lines,
   * untranslated, instead of putting a failed request beside every one of them. The
   * Tokens below are unaffected by that: kuromoji is local (ADR 0015).
   */
  const annotator = useMemo(
    () => (settings && slotConfigured(settings.textModel) ? buildAnnotator(settings) : null),
    [settings],
  );
  /** Which blocks have been sent to the model on this visit — see `nextWindow`. */
  const asked = useRef(new Set<number>());
  /**
   * One writer to the Transcript at a time. Both effects below read the whole thing,
   * merge into their copy and write it back, so two of them in flight would lose
   * whichever landed first — and tokenizing takes it as well as translating.
   */
  const busy = useRef(false);
  /** Bumped when a window lands, which is what asks for the one after it. */
  const [pass, setPass] = useState(0);
  /**
   * Which block is being listened to. A dependency rather than `position.lineIndex`
   * itself, so playing on through a block re-runs nothing and crossing into the next
   * one re-runs once — the effect below fires per block, not per Line.
   */
  const block = Math.floor(Math.max(0, position.lineIndex) / BLOCK_LINES);
  const [translating, setTranslating] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);

  useEffect(() => {
    asked.current = new Set();
    setAnnotationError(null);
    setRevealed(new Set());
  }, [id]);

  /**
   * Japanese Tokens — furigana and part-of-speech colouring — computed here rather
   * than during translation (ADR 0015). kuromoji runs in this browser against a
   * dictionary it downloads once: no key, no request, nothing to wait for but itself.
   * So it does not ride on the Text Model's latency, and a reader who has configured
   * only a proxy still gets readings over the Lines they are studying.
   *
   * Whether the episode is Japanese is decided over the whole Transcript, never over
   * the window being translated: a window with no kana in it is not evidence.
   *
   * Once for the whole Transcript, not per window — the expensive half is the
   * dictionary, and tokenizing eight hundred Lines after it is milliseconds. The guard
   * is the Lines themselves, so a Transcript that already carries Tokens (restored
   * from a backup, or read back after a previous visit) loads nothing at all.
   */
  useEffect(() => {
    const resource = data?.resource;
    const lines = data?.transcript;
    if (!resource || !lines?.length || busy.current) return;
    if (lines.every((line) => line.tokens)) return;
    if (!wantsJapanese(lines, resource.targetLanguage)) return;

    busy.current = true;
    japaneseTokenizer()
      .then(async (tokenizer) => {
        const tokenized = lines.map((line) => ({
          ...line,
          tokens: tokenizer.tokenize(line.text),
        }));
        setData((current) =>
          current?.resource.id === id ? { ...current, transcript: tokenized } : current,
        );
        // Not `save`: that writes the Resource row too, and the only one this screen
        // holds is whatever it read when it opened — under which a position has been
        // written on every pause since.
        await saveTranscript(id, tokenized);
      })
      .catch((failure: unknown) => setAnnotationError(reason(failure)))
      .finally(() => {
        busy.current = false;
        // Nothing re-runs this effect — `data` is unchanged when the dictionary failed
        // to load, which is what stops it retrying forever — but the translation below
        // was turned away while this held `busy`, and this is how it is asked again.
        setPass((n) => n + 1);
      });
  }, [data, id]);

  /**
   * Translation happens while listening rather than during the import (ADR 0011): the
   * window around the Line being played goes out as one request, and appears in the
   * lyrics as it lands. Someone resuming at twenty minutes waits for the Lines at
   * twenty minutes, not for the nineteen minutes before them — and an episode nobody
   * finishes is only paid for as far as it was listened to.
   *
   * Two things send a window and nothing else does: the screen opening, and playback
   * coming to rest in a block the last window did not reach. At rest, because this
   * re-runs whenever the block changes and a drag along the progress bar changes it
   * every few pixels (`SETTLE_MS`). One at a time, because `busy` keeps two from
   * overlapping and a window still out from an earlier visit to this screen is waited
   * for rather than sent again (`windowsInFlight`). And a window that failed does not
   * send the next one: a rate limit is the provider asking for fewer requests, so the
   * next waits for the next block.
   *
   * Where playback is comes from the `seconds` ref, so a seek mid-request retargets the
   * next window without cancelling the one in flight.
   */
  useEffect(() => {
    if (!annotator || !data?.transcript.length) return;
    const { resource, transcript: lines } = data;

    const timer = setTimeout(() => {
      if (busy.current) return;

      const earlier = windowsInFlight.get(id);
      if (earlier) {
        // Its answer goes to the store and to a screen that is no longer here, so it is
        // read back from the store once it lands instead of being paid for twice.
        busy.current = true;
        setTranslating(true);
        void earlier
          .then(async () => {
            const transcript = await getTranscript(id);
            if (transcript)
              setData((current) =>
                current?.resource.id === id ? { ...current, transcript } : current,
              );
          })
          .catch((failure: unknown) => setAnnotationError(reason(failure)))
          .finally(() => {
            busy.current = false;
            setTranslating(false);
            setPass((n) => n + 1);
          });
        return;
      }

      // Located from the `seconds` ref rather than from `block`: this also runs when a
      // window lands, and by then playback has moved on from the render that scheduled it.
      const next = nextWindow(lines, locate(lines, seconds.current).lineIndex, asked.current);
      if (!next) return;

      // Marked before the request rather than after it, so a window that fails is left
      // alone instead of being asked for again on the next render. A reload retries it.
      for (const asking of next.blocks) asked.current.add(asking);
      busy.current = true;
      setTranslating(true);

      // Decided over the whole Transcript, never over the window: a window with no kana
      // in it is not evidence that the episode is not Japanese, and Tokens appearing on
      // some blocks and not others is the bug that would follow.
      const targetLanguage =
        resource.targetLanguage ?? (wantsJapanese(lines) ? JAPANESE : undefined);

      const request = annotator
        .annotate(lines.slice(next.from, next.to), {
          nativeLanguage: resource.nativeLanguage,
          ...(targetLanguage && { targetLanguage }),
        })
        .then(async (annotated) => {
          const merged = [...lines.slice(0, next.from), ...annotated, ...lines.slice(next.to)];
          // Guarded by the Resource, not by an effect cleanup: an answer arriving after
          // a seek is still this episode's, and dropping it would leave those Lines
          // untranslated with their blocks already marked asked.
          setData((current) =>
            current?.resource.id === id ? { ...current, transcript: merged } : current,
          );
          // The Lines on their own. `save` would carry the Resource this screen read
          // when it opened, overwriting the position written under it since.
          await saveTranscript(id, merged);
          return true;
        })
        .catch((failure: unknown) => {
          setAnnotationError(reason(failure));
          return false;
        })
        .then((landed) => {
          windowsInFlight.delete(id);
          busy.current = false;
          setTranslating(false);
          if (landed) setPass((n) => n + 1);
        });
      windowsInFlight.set(id, request);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [annotator, data, id, block, pass]);

  /**
   * The shortcuts a listening tool actually needs. Line-granular, not ±5s: the whole
   * point of the Transcript is that the Line is the unit worth repeating.
   *
   * Where playback is comes from the audio element, never from `position` — reading
   * state here would re-bind this listener on every Word, sixty times a second.
   */
  useEffect(() => {
    const lines = data?.transcript;
    if (!lines?.length) return;

    const onKey = (event: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio || event.metaKey || event.ctrlKey || event.altKey) return;
      // A text field, a select, or the open dialog owns its own keys. The instanceof
      // is not ceremony: a keydown can be dispatched at the window, which has no
      // closest() and would throw the listener away mid-press.
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, dialog"))
        return;

      switch (event.key) {
        // Space means play/pause everywhere on this screen, even on a focused button:
        // preventDefault cancels that button's own activation, so there is one answer
        // to one key rather than two depending on where focus happens to be.
        case " ":
          event.preventDefault();
          if (audio.paused) void audio.play();
          else audio.pause();
          return;
        case "ArrowLeft":
          event.preventDefault();
          return jump(-1);
        case "ArrowRight":
          event.preventDefault();
          return jump(1);
        case "r":
        case "R":
          event.preventDefault();
          return jump(0);
        case "l":
        case "L":
          event.preventDefault();
          setLoop((was) => !was);
          return;
        // Both, the original alone, and blind, in that order — the order a listener
        // takes them in when they are working a passage down to nothing.
        case "t":
        case "T":
          event.preventDefault();
          setMode((was) => MODES[(MODES.indexOf(was) + 1) % MODES.length]!);
          return;
      }
    };

    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [data]);

  /** The Line the view last glided to, so that a re-run for any other reason holds still. */
  const followed = useRef(-1);

  /**
   * Keep the current Line in view while following is on. Re-running this when following
   * turns back on is what sends the view straight to the current Line — the floating
   * control just flips the flag, no separate imperative scroll needed.
   *
   * A new Line glides into place; anything else that moves it is undone in the same
   * frame. Translations landing, Tokens arriving and a change of subtitle mode all reflow
   * the Lines above the one being read, and nothing else would put it back: with every
   * translation hidden at once, the current Line moved 113px on a phone even in Chrome,
   * whose scroll anchoring holds still only what sits at the top of the list. A layout
   * effect, so that the correction lands before the frame that would have shown the jump.
   */
  useLayoutEffect(() => {
    const row = listRef.current?.children[position.lineIndex];
    if (!following || !row) {
      followed.current = -1;
      return;
    }
    const glide =
      followed.current !== position.lineIndex &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    followed.current = position.lineIndex;
    row.scrollIntoView({ block: "center", behavior: glide ? "smooth" : "auto" });
  }, [position.lineIndex, following, data?.transcript, mode]);

  /**
   * The lock screen, the notification shade and the headphone buttons. Worth wiring
   * precisely rather than accepting the default: the two track buttons there mean
   * "previous Line" and "next Line" here, which is the only control a listener wants
   * while the phone is in a pocket. Re-registered whenever a translation lands, which
   * is cheap, and guarded because the API is absent in some engines.
   */
  useEffect(() => {
    const resource = data?.resource;
    if (!resource || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    // The show where an album would go, and its cover on the lock screen.
    if (typeof MediaMetadata === "function")
      session.metadata = new MediaMetadata({
        title: resource.title,
        ...(resource.showTitle && { artist: resource.showTitle }),
        ...(resource.artworkUrl && { artwork: [{ src: resource.artworkUrl }] }),
      });
    session.playbackState = playing ? "playing" : "paused";

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void audioRef.current?.play()],
      ["pause", () => audioRef.current?.pause()],
      ["previoustrack", () => jump(-1)],
      ["nexttrack", () => jump(1)],
    ];
    // An engine that does not implement one of these throws rather than ignoring it,
    // and one unsupported action would otherwise cost the three beside it.
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [data, playing]);

  /**
   * A Line chosen from the list: play from its start, and show it if Lines are hidden.
   * Bound once, and handed the Line back by the row, so that the rows can be memoised —
   * see LineRow.
   */
  const seekLine = useCallback((line: Line, index: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    loopLine.current = line;
    audio.currentTime = line.startSec;
    void audio.play();
    setRevealed((was) => (was.has(index) ? was : new Set(was).add(index)));
  }, []);

  const askLine = useCallback((line: Line) => {
    // Reading a line's grammar and listening to the next one at once is not the point
    // of this dialog.
    audioRef.current?.pause();
    setAsking(line.text);
  }, []);

  /**
   * The Station look's tick per Line, placed by start time along the band. Built once
   * per Transcript rather than per frame, and not at all where there would be too many
   * to mean anything.
   */
  const span = duration || data?.resource.durationSec || 0;
  const ticks = useMemo(() => {
    const lines = data?.transcript;
    if (!lines?.length || lines.length > MAX_TICKS || !span) return null;
    return lines.map((line, index) => (
      <i key={index} style={{ left: `${Math.min(100, (line.startSec / span) * 100)}%` }} />
    ));
  }, [data?.transcript, span]);

  if (error)
    return (
      <PlayerStub>
        <p className="error">{error}</p>
      </PlayerStub>
    );
  if (!data)
    return (
      <PlayerStub>
        <p className="notice">{t("common.loading")}</p>
      </PlayerStub>
    );

  const { resource, transcript, audioUrl } = data;
  // Nothing is importing this episode any more, so an offer to transcribe it is real
  // rather than a second run of something already under way. The phase alone cannot
  // say that — it reads the same whether an import is running or was abandoned by a
  // reload — so `isImporting` is the half that knows, and the guard inside `run` is
  // what catches the click that beat this to it.
  const resting =
    (resource.phase === "untranscribed" || resource.phase === "failed") &&
    !isImporting(resource.id);
  const canTranscribe = slotConfigured(settings?.transcriptionModel);

  const here = position.lineIndex;
  const total = transcript.length;
  const previous = transcript[here - 1];
  const upcoming = transcript[here + 1];
  const name = resource.showTitle ?? resource.title;
  const pair = `${
    resource.targetLanguage ? languageOf(resource.targetLanguage) : t("library.autoLanguage")
  } → ${languageOf(resource.nativeLanguage)}`;
  // Before the first Line starts the first one is next, so it is the one counted.
  const counter = total ? t("player.lineOf", { n: Math.max(1, here + 1), total }) : "";
  // The Lines are in the studied language and the translations in the reader's own,
  // and saying so is not pedantry: a Han character is drawn differently in Japanese
  // and in Chinese, and without it a Chinese interface sets every kanji of a Japanese
  // Transcript in its Chinese form.
  const textLang =
    resource.targetLanguage ?? (wantsJapanese(transcript) ? JAPANESE : undefined);

  return (
    <>
      <header className="topbar player-bar">
        {/* A link home rather than history.back(): a deep link opens this screen with
            nothing behind it, and an installed app has no browser Back to fall on. */}
        <a href="#/" className="back">
          <Icon name="chevron-left" />
          <span>{t("nav.library")}</span>
        </a>
        <Cover src={resource.artworkUrl} name={name} />
        <LineBadge resource={resource} />
        <div className="bar-title">
          <h1>{resource.title}</h1>
          <small>
            {[resource.showTitle, formatTime(duration || resource.durationSec), pair]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        <a
          href="#/settings"
          className="icon-button"
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <Icon name="gear" />
        </a>
      </header>

      <main className="player" data-subtitles={mode}>
        {resource.artworkUrl && (
          <Backdrop key={resource.artworkUrl} src={resource.artworkUrl} />
        )}

        {/* No `controls`. The native widget is three different shapes in three engines,
            none of them in this palette, and the one control this screen is about —
            move by a Line — is in none of them. What is left is the decoder, which is
            all this element was ever wanted for. */}
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = rate;
            const resume = resource.lastPositionSec ?? 0;
            if (resume > 0) event.currentTarget.currentTime = resume;
          }}
        />

        {/* The controls come before the Lines in the document, wherever they are drawn:
            a keyboard reaches the transport in a few presses instead of after tabbing
            through every Line of an episode. */}
        <aside className="side">
          <div className="episode" aria-hidden="true">
            <Cover src={resource.artworkUrl} name={name} />
            <p className="episode-title">{resource.title}</p>
            <p className="episode-meta">
              {[resource.showTitle, pair].filter(Boolean).join(" · ")}
            </p>
          </div>

          <div className="dock">
            {/* The Station look's status strip. Hidden from assistive technology: every
                state on it is also the pressed state of a control below. */}
            <p className="ticker" aria-hidden="true">
              <span>{playing ? t("player.playing") : t("player.paused")}</span>
              <span>{counter}</span>
              <span className={loop ? undefined : "off"}>
                {t("player.repeat")} {loop ? t("common.on") : t("common.off")}
              </span>
              <span className={mode === "both" ? "off" : undefined}>
                {t("player.subtitles")} {t(MODE_LABELS[mode])}
              </span>
              {translating && <span>{t("player.translating")}</span>}
            </p>

            <p className="ends" aria-hidden="true">
              <span className="end">
                {previous && (
                  <>
                    <b>{t("player.previousLine")}</b>{" "}
                    <span lang={textLang}>{previous.text}</span>
                  </>
                )}
              </span>
              <span className="end">
                {upcoming && (
                  <>
                    <span lang={textLang}>{upcoming.text}</span> <b>{t("player.nextLine")}</b>
                  </>
                )}
              </span>
            </p>

            <div className="scrub">
              {ticks && (
                <span className="ticks" aria-hidden="true">
                  {ticks}
                </span>
              )}
              {/* `defaultValue`, and the frame loop writes `value` on the DOM node from
                  there on — see paintTransport. A controlled input would put the
                  playhead in React state and re-render every Line sixty times a second. */}
              <input
                ref={scrubRef}
                type="range"
                min={0}
                max={duration || resource.durationSec || 1}
                step="any"
                defaultValue={resource.lastPositionSec ?? 0}
                aria-label={t("player.position")}
                onPointerDown={() => (scrubbing.current = true)}
                onPointerUp={() => (scrubbing.current = false)}
                onPointerCancel={() => (scrubbing.current = false)}
                onInput={(event) => {
                  const audio = audioRef.current;
                  if (audio) audio.currentTime = Number(event.currentTarget.value);
                  paintPlayed(event.currentTarget);
                }}
              />
            </div>
            <p className="times">
              <span ref={elapsedRef}>{formatTime(resource.lastPositionSec ?? 0)}</span>
              <span className="counter">{counter}</span>
              <span ref={remainingRef} />
            </p>

            <div className="controls">
              <div className="transport">
                <button
                  type="button"
                  className="step labeled"
                  title={t("player.replay")}
                  onClick={() => jump(0)}
                >
                  <Icon name="replay" />
                  <span className="label">{t("player.replayShort")}</span>
                </button>
                <button
                  type="button"
                  className="step"
                  aria-label={t("player.previousLine")}
                  onClick={() => jump(-1)}
                >
                  <Icon name="skip-prev" />
                </button>
                <button
                  type="button"
                  className="play"
                  aria-label={playing ? t("player.pause") : t("player.play")}
                  onClick={toggle}
                >
                  <Icon name={playing ? "pause" : "play"} size={1.4} />
                </button>
                <button
                  type="button"
                  className="step"
                  aria-label={t("player.nextLine")}
                  onClick={() => jump(1)}
                >
                  <Icon name="skip-next" />
                </button>
                {/* Drilling one hard sentence: hold the current Line until this goes off
                    again, or a different Line becomes current — see the sampler above. */}
                <button
                  type="button"
                  className={loop ? "step labeled loop on" : "step labeled loop"}
                  aria-pressed={loop}
                  title={t("player.repeatTitle")}
                  onClick={() => setLoop(!loop)}
                >
                  <Icon name="repeat-one" />
                  <span className="label">{t("player.repeat")}</span>
                </button>
              </div>

              <fieldset className="seg modes">
                <legend className="visually-hidden">{t("player.subtitles")}</legend>
                {MODES.map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="subtitles"
                      value={value}
                      checked={mode === value}
                      onChange={() => setMode(value)}
                    />
                    <span>{t(MODE_LABELS[value])}</span>
                  </label>
                ))}
              </fieldset>

              {/* A native select, where six buttons and a slider used to be: it is one
                  control's width in the dock, it opens the system's own picker on a
                  phone, and a keyboard already knows how to drive it. */}
              <label className="rate">
                <span className="visually-hidden">{t("player.speed")}</span>
                <select
                  value={String(rate)}
                  onChange={(event) => setRate(Number(event.target.value))}
                >
                  {rateChoices(rate).map((value) => (
                    <option key={value} value={String(value)}>
                      {formatRate(value)}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={0.85} />
              </label>
            </div>

            <p className="shortcuts">
              <span>
                <kbd>Space</kbd> {t("player.keyPlay")}
              </span>
              <span>
                <kbd>←</kbd>
                <kbd>→</kbd> {t("player.keyLine")}
              </span>
              <span>
                <kbd>R</kbd> {t("player.keyReplay")}
              </span>
              <span>
                <kbd>L</kbd> {t("player.keyLoop")}
              </span>
              <span>
                <kbd>T</kbd> {t("player.keySubtitles")}
              </span>
            </p>
          </div>
        </aside>

        <div className="lyrics-wrap">
          {/* Floating, not in the flow: a window lands every few seconds while this is
              up, and a line of text appearing and going above the Lines would push
              the one being read up and down with it. */}
          {translating && <p className="translating">{t("player.translating")}</p>}

          {transcript.length === 0 ? (
            // Where the lyrics would be, rather than a line of grey text above an empty
            // screen: this is the whole of what the reader came here for, and its
            // absence has one specific cause and one specific fix.
            <div className="locked">
              <Icon name="subtitles" size={2} />
              {retrying ? (
                <p>
                  {t(`phase.${retrying.phase}`)}
                  {retrying.progress !== undefined &&
                    ` ${Math.round(retrying.progress * 100)}%`}
                </p>
              ) : !resting ? (
                // Something is importing this episode in another tab, and the poll
                // above is watching for its Lines. Offering to run it a second time is
                // not help.
                <p>{t("player.noTranscript")}</p>
              ) : canTranscribe ? (
                <>
                  <p>{retryError ?? resource.failureReason ?? t("player.noTranscript")}</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void retryTranscription()}
                  >
                    {t("player.retryTranscription")}
                  </button>
                </>
              ) : (
                <>
                  <p>{t("player.needsTranscription")}</p>
                  <a href="#/settings" className="button primary">
                    {t("nav.settings")}
                  </a>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Beside the lyrics rather than instead of them: a rate-limited
                  translation, or a dictionary that would not load, leaves an episode
                  that still plays and still has its Lines. */}
              {(annotationError || mode === "none") && (
                <div className="notices">
                  {annotationError && <p className="error">{annotationError}</p>}
                  {mode === "none" && <p className="notice">{t("player.revealHint")}</p>}
                </div>
              )}
              <ol
                className="lyrics"
                ref={listRef}
                onWheel={() => setFollowing(false)}
                onTouchMove={() => setFollowing(false)}
                onKeyDown={(event) => {
                  if (SCROLL_KEYS.has(event.key)) setFollowing(false);
                }}
              >
                {transcript.map((line, index) => (
                  <LineRow
                    key={index}
                    line={line}
                    index={index}
                    state={
                      index === here
                        ? "current"
                        : index < here
                          ? "passed"
                          : index === here + 1
                            ? "next"
                            : ""
                    }
                    looping={loop && index === here}
                    wordIndex={index === here ? position.wordIndex : null}
                    lang={textLang}
                    translationLang={resource.nativeLanguage}
                    // Only the hidden mode reads this, so no other mode re-renders a row
                    // for having been chosen once.
                    revealed={mode === "none" && revealed.has(index)}
                    onSeek={seekLine}
                    onAsk={askLine}
                  />
                ))}
              </ol>
              {!following && here >= 0 && (
                <button
                  type="button"
                  className="jump-to-current"
                  onClick={() => setFollowing(true)}
                >
                  {t("player.jumpToCurrent")}
                </button>
              )}
            </>
          )}
        </div>

        <AskDialog text={asking} onClose={() => setAsking(null)} />
      </main>
    </>
  );
}

/** Before there is an episode to show, or when there is none to show: still a way back. */
function PlayerStub({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <>
      <header className="topbar player-bar">
        <a href="#/" className="back">
          <Icon name="chevron-left" />
          <span>{t("nav.library")}</span>
        </a>
      </header>
      <main className="player-stub">{children}</main>
    </>
  );
}

/**
 * The cover, blurred past recognition and laid under the whole player — a lyric page
 * taking its colour from the show, the way a music app takes it from the album. Only the
 * Standard look draws it, and a cover that will not load takes the wash with it rather
 * than leaving a broken image under the Lines.
 */
function Backdrop({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="backdrop" aria-hidden="true">
      <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </div>
  );
}

/** Where a Line stands relative to the one being spoken, as its class. */
type LineState = "passed" | "current" | "next" | "";

/**
 * One Line. Memoised, and every prop is either stable or specific to this row, so a
 * Word moving on re-renders the Line being spoken rather than the eight hundred around
 * it: the two callbacks are the screen's, bound once, and are handed the Line back.
 */
const LineRow = memo(function LineRow({
  line,
  index,
  state,
  looping,
  wordIndex,
  revealed,
  lang,
  translationLang,
  onSeek,
  onAsk,
}: {
  line: Line;
  index: number;
  state: LineState;
  looping: boolean;
  wordIndex: number | null;
  revealed: boolean;
  /** The studied language when it is known, and the reader's own. */
  lang: string | undefined;
  translationLang: string;
  onSeek: (line: Line, index: number) => void;
  onAsk: (line: Line) => void;
}) {
  const t = useT();
  const classes = [state, looping && "looping", revealed && "revealed"].filter(Boolean);
  return (
    <li className={classes.length ? classes.join(" ") : undefined}>
      {/* A <button>, not an <li onClick> — Tab, Enter, the focus ring and the screen
          reader all come free, and the ask button beside it stops being a click that
          has to be swallowed before it reaches the Line underneath. */}
      <button type="button" className="seek" onClick={() => onSeek(line, index)}>
        <span className="stamp">{formatTime(line.startSec)}</span>
        <span className="words">
          <span className="text" lang={lang}>
            <LineText line={line} current={state === "current"} wordIndex={wordIndex} />
          </span>
          {line.translation && (
            <span className="translation" lang={translationLang}>
              {line.translation}
            </span>
          )}
        </span>
      </button>
      {/* An icon and a real accessible name, where a bare "?" announced as "question
          mark" and read as a help button rather than an offer to explain the Line. */}
      <button
        type="button"
        className="ask"
        aria-label={t("player.askTitle")}
        title={t("player.askTitle")}
        onClick={() => onAsk(line)}
      >
        <Icon name="wand-sparkle" size={1} />
      </button>
    </li>
  );
});

/**
 * Three renderings of one Line, in priority order:
 *
 * 1. Any Line with Tokens — furigana and part-of-speech colouring. Every such Line
 *    carries them, lit or not, and the stylesheet shows them only on the one that plays
 *    (ADR 0005): a reading takes room above its text, and drawn on the current Line
 *    alone it made that Line taller as it lit and shorter as it passed, moving every
 *    Line below. The current Line is swept via `tokenWords`, which lights each Token
 *    for the whole run of Words it covers rather than for the first of them.
 * 2. The current Line with Words — the same sweep over slices of the Line's own
 *    text, so the spaces between words survive (ADR 0004). Those are plain inline
 *    spans, which wrap exactly as the text does, so they can stay the current Line's.
 * 3. Everything else — plain text.
 *
 * Tokens and Words are never merged into one list: they are different things
 * measured from different places, and `tokenWords` reconciles them by character
 * offset instead, so a Word covering three Tokens lights all three at once.
 */
function LineText({
  line,
  current,
  wordIndex,
}: {
  line: Line;
  current: boolean;
  wordIndex: number | null;
}) {
  // Per Line, not per frame: this re-renders on every Word change, and neither
  // answer depends on anything but the Line.
  const spokenBy = useMemo(() => tokenWords(line), [line]);
  const slices = useMemo(() => wordSlices(line), [line]);

  if (line.tokens?.length) {
    return (
      <>
        {line.tokens.map((token, index) => (
          <TokenText
            key={index}
            token={token}
            sweep={current ? sweepState(spokenBy?.[index], wordIndex) : ""}
          />
        ))}
      </>
    );
  }
  if (current && slices) {
    return (
      <>
        {slices.map((slice, index) => (
          // One slice is sounded by exactly one Word, which is the degenerate range.
          <span key={index} className={`word ${sweepState([index, index + 1], wordIndex)}`}>
            {slice}
          </span>
        ))}
      </>
    );
  }
  return <>{line.text}</>;
}

/** Furigana is native HTML; a reading is only present when the surface has kanji. */
function TokenText({ token, sweep }: { token: Token; sweep: string }) {
  const body = token.reading ? (
    <ruby>
      {token.surface}
      <rt>{token.reading}</rt>
    </ruby>
  ) : (
    token.surface
  );
  return <span className={`tok pos-${token.partOfSpeech} ${sweep}`}>{body}</span>;
}

/** The ask-AI popup — one Text Model call about one Line, in the native language. */
function AskDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!text) return;
    setAnswer(null);
    dialogRef.current?.showModal();
    let dropped = false;

    (async () => {
      const settings = await readSettings();
      // The Text Model specifically, not "settings exist": an episode can be imported
      // and listened to with only a proxy configured, and a Transcript restored from a
      // backup brings its Lines along with it, so this button is reachable long before
      // anybody has filled this slot in.
      if (!settings || !slotConfigured(settings.textModel))
        throw new Error(t("player.needsTextModel"));
      // The question is asked in the reader's own language, and that is what makes
      // the answer come back in it — no sentence instructing the model to.
      const prompt = t("ask.prompt", { text });
      for await (const chunk of createTextModel({ slot: settings.textModel }).completeStream(
        prompt,
      )) {
        if (dropped) return;
        setAnswer((prev) => (prev ?? "") + chunk);
      }
    })().catch((failure: unknown) => {
      // Whatever went wrong lands in the answer, where the reader is already looking.
      // completeStream never retries, so a failure half way through cannot end up
      // showing a second answer underneath the first.
      if (!dropped) setAnswer((prev) => (prev ?? "") + reason(failure));
    });

    return () => {
      dropped = true;
    };
  }, [text, t]);

  return (
    <dialog ref={dialogRef} className="sheet ask-sheet" onClose={onClose}>
      <p className="quote">{text}</p>
      <div className="answer">
        {answer ? (
          <Markdown remarkPlugins={[remarkGfm]}>{answer}</Markdown>
        ) : (
          t("player.asking")
        )}
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>
          {t("common.close")}
        </button>
      </div>
    </dialog>
  );
}
