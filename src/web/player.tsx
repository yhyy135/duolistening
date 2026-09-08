// The lyrics view: an <audio> element, a Transcript that follows it, and the ask-AI
// popup. Everything about "which Line is playing" comes from shared/locate.ts, which
// is pure and already tested — this file only turns its answer into DOM.

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  JAPANESE,
  type Line,
  type Resource,
  type Settings,
  slotConfigured,
  type Token,
  type Transcript,
} from "../shared/model.ts";
import { type Position, locate, tokenWords, wordSlices } from "../shared/locate.ts";
import { BLOCK_LINES, nextWindow, wantsJapanese } from "./annotate.ts";
import { Icon } from "./icons.tsx";
import { retryImport, type ImportProgress } from "./import.ts";
import { buildAnnotator, buildImportDeps } from "./pipeline.ts";
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
import { useT } from "./i18n.ts";
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

/** The stops worth one click. Slow first: this is a listening tool, not a podcast app. */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const RATE_KEY = "duolistening.rate";

/** Native list-scrolling keys. Arrow-left/right are deliberately not here: those are
    the app's own line shortcuts below, and a jump they cause should still be followed. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

const NOWHERE: Position = { lineIndex: -1, wordIndex: null };

/** Playback speed is a habit, not a per-episode choice, so it outlives the page. */
function storedRate(): number {
  const stored = Number(localStorage.getItem(RATE_KEY));
  return stored >= 0.5 && stored <= 2 ? stored : 1;
}

export function PlayerScreen({ id }: { id: string }) {
  const [data, setData] = useState<PlayableResource | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>(NOWHERE);
  const [asking, setAsking] = useState<string | null>(null);
  const t = useT();
  const [rate, setRate] = useState(storedRate);
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
    if (scrubRef.current && !scrubbing.current)
      scrubRef.current.value = String(audio.currentTime);
  };

  /**
   * Playback moved by whole Lines, which is the unit this app is about — not by ±15
   * seconds, the way a podcast app would. The arrow keys, the transport's two side
   * buttons and the lock screen's track buttons are three ways into this one
   * function; a `delta` of 0 replays the Line being listened to.
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
  // turning the toggle on mid-line loops whatever is already playing. `seek` and
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

  // ---------------------------------------------------------------- translation

  /**
   * One per Settings, not one per window: the kuromoji dictionary is a download.
   *
   * Null when no Text Model is configured, and the effect below then does nothing at
   * all — a Transcript restored from a backup still shows its Lines, untranslated,
   * instead of putting a failed request beside every one of them.
   */
  const annotator = useMemo(
    () => (settings && slotConfigured(settings.textModel) ? buildAnnotator(settings) : null),
    [settings],
  );
  /** Which blocks have been sent to the model on this visit — see `nextWindow`. */
  const asked = useRef(new Set<number>());
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
  const [translationError, setTranslationError] = useState<string | null>(null);

  useEffect(() => {
    asked.current = new Set();
    setTranslationError(null);
  }, [id]);

  /**
   * Translation happens while listening rather than during the import (ADR 0011): the
   * window around the Line being played goes out, one request at a time, and appears
   * in the lyrics as it lands. Someone resuming at twenty minutes waits for the Lines
   * at twenty minutes, not for the nineteen minutes before them — and an episode
   * nobody finishes is only paid for as far as it was listened to.
   *
   * The loop is the effect re-running rather than a `while`: each window ends by
   * bumping `pass`, and `busy` is what keeps two of them from overlapping. Where
   * playback is comes from the `seconds` ref, so a seek mid-request retargets the
   * next window without cancelling the one in flight.
   */
  useEffect(() => {
    const resource = data?.resource;
    const lines = data?.transcript;
    if (!annotator || !resource || !lines?.length || busy.current) return;

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

    annotator
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
      })
      .catch((failure: unknown) => setTranslationError(reason(failure)))
      .finally(() => {
        busy.current = false;
        setTranslating(false);
        setPass((n) => n + 1);
      });
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
      }
    };

    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [data]);

  // Keep the current Line in view while following is on. Re-running this when
  // following turns back on is what sends the view straight to the current Line —
  // the floating control just flips the flag, no separate imperative scroll needed.
  useEffect(() => {
    if (!following || position.lineIndex < 0) return;
    listRef.current?.children[position.lineIndex]?.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [position.lineIndex, following]);

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
    if (typeof MediaMetadata === "function")
      session.metadata = new MediaMetadata({ title: resource.title });
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

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="notice">{t("common.loading")}</p>;

  const { resource, transcript, audioUrl } = data;
  // Nothing is importing this episode any more, so an offer to transcribe it is real
  // rather than a second run of something already under way.
  const resting = resource.phase === "untranscribed" || resource.phase === "failed";
  const canTranscribe = slotConfigured(settings?.transcriptionModel);
  const seek = (line: Line) => {
    const audio = audioRef.current;
    if (!audio) return;
    loopLine.current = line;
    audio.currentTime = line.startSec;
    void audio.play();
  };

  return (
    <main className="player">
      {translating && <p className="notice">{t("player.translating")}</p>}
      {/* Beside the lyrics rather than instead of them: a rate-limited translation
          leaves an episode that still plays and still has its Lines. */}
      {translationError && <p className="error">{translationError}</p>}

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

      <section className="now-playing">
        <h1>{resource.title}</h1>

        <div className="scrub">
          {/* `defaultValue`, and the frame loop writes `value` on the DOM node from
              there on — see paintTransport. A controlled input would put the playhead
              in React state and re-render every Line sixty times a second. */}
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
            }}
          />
          <p className="times">
            <span ref={elapsedRef}>{formatTime(resource.lastPositionSec ?? 0)}</span>
            <span ref={remainingRef} />
          </p>
        </div>

        <div className="controls">
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
              again, or a different Line becomes current — see the sampler above. It
              sits in the transport rather than below it because that is where a
              listener looks for it, and because a row of its own was costing three
              lines of lyrics on a phone. */}
          <button
            type="button"
            className={`step loop ${loop ? "on" : ""}`}
            aria-pressed={loop}
            aria-label={t("player.repeat")}
            title={t("player.repeatTitle")}
            onClick={() => setLoop(!loop)}
          >
            <Icon name="repeat-one" />
          </button>
        </div>

        <Transport rate={rate} onRate={setRate} />
      </section>

      {transcript.length === 0 ? (
        // Where the lyrics would be, rather than a line of grey text above an empty
        // screen: this is the whole of what the reader came here for, and its absence
        // has one specific cause and one specific fix.
        <div className="lyrics-wrap">
          <div className="locked">
            <Icon name="gear" size={2} />
            {retrying ? (
              <p>
                {t(`phase.${retrying.phase}`)}
                {retrying.progress !== undefined && ` ${Math.round(retrying.progress * 100)}%`}
              </p>
            ) : !resting ? (
              // Something is importing this episode in another tab, and the poll above
              // is watching for its Lines. Offering to run it a second time is not help.
              <p>{t("player.noTranscript")}</p>
            ) : canTranscribe ? (
              <>
                <p>{retryError ?? resource.failureReason ?? t("player.noTranscript")}</p>
                <button type="button" onClick={() => void retryTranscription()}>
                  {t("player.retryTranscription")}
                </button>
              </>
            ) : (
              <>
                <p>{t("player.needsTranscription")}</p>
                <a href="#/settings">{t("nav.settings")}</a>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="lyrics-wrap">
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
                current={index === position.lineIndex}
                looping={loop && index === position.lineIndex}
                wordIndex={index === position.lineIndex ? position.wordIndex : null}
                onSeek={() => seek(line)}
                onAsk={() => {
                  // Reading a line's grammar and listening to the next one at once
                  // is not the point of this dialog.
                  audioRef.current?.pause();
                  setAsking(line.text);
                }}
              />
            ))}
          </ol>
          {!following && position.lineIndex >= 0 && (
            <button
              type="button"
              className="jump-to-current"
              onClick={() => setFollowing(true)}
            >
              {t("player.jumpToCurrent")}
            </button>
          )}
        </div>
      )}

      <AskDialog text={asking} onClose={() => setAsking(null)} />
    </main>
  );
}

/**
 * Speed, pulled out of the native controls where only Chrome exposes it and only
 * through a context menu. Six stops one click away, and a slider for everything
 * between them — the stops are also the slider's tick marks, so the two controls
 * are visibly the same scale rather than two ways to set the same number.
 */
function Transport({ rate, onRate }: { rate: number; onRate: (rate: number) => void }) {
  const t = useT();
  return (
    <div className="transport">
      <div className="rates">
        {RATES.map((value) => (
          <button
            key={value}
            type="button"
            className={value === rate ? "on" : ""}
            aria-pressed={value === rate}
            onClick={() => onRate(value)}
          >
            {value}×
          </button>
        ))}
      </div>

      <label className="custom">
        <span className="visually-hidden">{t("player.speed")}</span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          list="rate-stops"
          value={rate}
          onChange={(event) => onRate(Number(event.target.value))}
        />
        <datalist id="rate-stops">
          {RATES.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        {rate.toFixed(2)}×
      </label>

      <p className="shortcuts">
        <kbd>Space</kbd> {t("player.keyPlay")}
        <span className="gap" />
        <kbd>←</kbd>
        <kbd>→</kbd> {t("player.keyLine")}
        <span className="gap" />
        <kbd>R</kbd> {t("player.keyReplay")}
        <span className="gap" />
        <kbd>L</kbd> {t("player.keyLoop")}
      </p>
    </div>
  );
}

function LineRow({
  line,
  current,
  looping,
  wordIndex,
  onSeek,
  onAsk,
}: {
  line: Line;
  current: boolean;
  looping: boolean;
  wordIndex: number | null;
  onSeek: () => void;
  onAsk: () => void;
}) {
  const t = useT();
  return (
    <li className={current ? (looping ? "current looping" : "current") : ""}>
      {/* A <button>, not an <li onClick> — Tab, Enter, the focus ring and the screen
          reader all come free, and the ask button beside it stops being a click that
          has to be swallowed before it reaches the Line underneath. */}
      <button type="button" className="seek" onClick={onSeek}>
        <span className="text">
          <LineText line={line} current={current} wordIndex={wordIndex} />
        </span>
        {line.translation && <span className="translation">{line.translation}</span>}
      </button>
      {/* An icon and a real accessible name, where a bare "?" announced as "question
          mark" and read as a help button rather than an offer to explain the Line. */}
      <button
        type="button"
        className="ask"
        aria-label={t("player.askTitle")}
        title={t("player.askTitle")}
        onClick={onAsk}
      >
        <Icon name="wand-sparkle" size={1} />
      </button>
    </li>
  );
}

/**
 * Three renderings of one Line, in priority order:
 *
 * 1. The current Line with Tokens — furigana and part-of-speech colouring, shown
 *    only while it plays (ADR 0005), swept word by word via `tokenWords`.
 * 2. The current Line with Words — the same sweep over slices of the Line's own
 *    text, so the spaces between words survive (ADR 0004).
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

  if (current && line.tokens?.length) {
    return (
      <>
        {line.tokens.map((token, index) => (
          <TokenText key={index} token={token} sweep={sweep(spokenBy?.[index], wordIndex)} />
        ))}
      </>
    );
  }
  if (current && slices) {
    return (
      <>
        {slices.map((slice, index) => (
          <span key={index} className={`word ${sweep(index, wordIndex)}`}>
            {slice}
          </span>
        ))}
      </>
    );
  }
  return <>{line.text}</>;
}

/**
 * Where one piece of the current Line sits in the karaoke sweep. Empty when there is
 * no word timing to sweep with — the Line is then highlighted whole (ADR 0004), and
 * dimming its pieces would only make that look broken.
 */
function sweep(word: number | undefined, wordIndex: number | null): string {
  if (word === undefined || wordIndex === null) return "";
  return word < wordIndex ? "said" : word === wordIndex ? "now" : "pending";
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
    <dialog ref={dialogRef} className="ask-dialog" onClose={onClose}>
      <p className="text">{text}</p>
      <div className="answer">
        {answer ? (
          <Markdown remarkPlugins={[remarkGfm]}>{answer}</Markdown>
        ) : (
          t("player.asking")
        )}
      </div>
      <button onClick={() => dialogRef.current?.close()}>{t("common.close")}</button>
    </dialog>
  );
}
