// The lyrics view: an <audio> element, a Transcript that follows it, and the ask-AI
// popup. Everything about "which Line is playing" comes from shared/locate.ts, which
// is pure and already tested — this file only turns its answer into DOM.

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JobState, Line, Token } from "../shared/model.ts";
import { type Position, locate, tokenWords, wordSlices } from "../shared/locate.ts";
import { type PlayableResource, api, reason } from "./api.ts";
import { useT } from "./i18n.ts";

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
  const [translating, setTranslating] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>(NOWHERE);
  const [asking, setAsking] = useState<string | null>(null);
  const t = useT();
  const [rate, setRate] = useState(storedRate);
  // On by default; a user scroll turns it off and it stays off, no timer. The only
  // way back is the floating control, once the reader wants to be found again.
  const [following, setFollowing] = useState(true);
  const [loop, setLoop] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
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
    setTranslating(null);
    setPosition(NOWHERE);
    setFollowing(true);
    loopLine.current = null;
    api.resource(id).then(setData, (failure: unknown) => setError(reason(failure)));
  }, [id]);

  // Opened while translation is still filling in: follow the same import job the
  // shelf watches, and on every tick re-fetch the Transcript so newly-translated
  // Lines appear without a reload. `playbackUrl` is deliberately left out of the
  // merge — on S3 it is a presigned URL that differs on every fetch, and replacing
  // it would reset the <audio> element mid-playback.
  useEffect(() => {
    const phase = data?.resource.phase;
    if (!phase || phase === "ready" || phase === "failed") return;
    return api.watchImport(id, (state) => {
      setTranslating(state);
      api
        .resource(id)
        .then((fresh) =>
          setData(
            (current) =>
              current && { ...current, resource: fresh.resource, transcript: fresh.transcript },
          ),
        );
    });
  }, [id, data?.resource.phase]);

  useEffect(
    () => () => {
      if (seconds.current > 0) void api.savePosition(id, seconds.current);
    },
    [id],
  );

  // Neither the unmount cleanup above nor the pause/seeked saves below run when the
  // tab is closed, the browser quits, or iOS Safari backgrounds the app — pagehide
  // and a visibilitychange to hidden are what's left to catch those.
  useEffect(() => {
    const onHide = () => {
      if (seconds.current > 0) api.savePositionBeacon(id, seconds.current);
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
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      sample();
      if (seconds.current > 0) void api.savePosition(id, seconds.current);
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
    audio.addEventListener("seeked", sample);
    audio.addEventListener("timeupdate", mark);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("seeked", sample);
      audio.removeEventListener("timeupdate", mark);
    };
  }, [data, id]);

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

    const jump = (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const here = locate(lines, audio.currentTime).lineIndex;
      const index = Math.max(0, Math.min(lines.length - 1, here < 0 ? 0 : here + delta));
      loopLine.current = lines[index]!;
      audio.currentTime = lines[index]!.startSec;
      void audio.play();
    };

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

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="notice">{t("common.loading")}</p>;

  const { resource, transcript, playbackUrl } = data;
  const seek = (line: Line) => {
    const audio = audioRef.current;
    if (!audio) return;
    loopLine.current = line;
    audio.currentTime = line.startSec;
    void audio.play();
  };

  return (
    <main className="player">
      <h1>{resource.title}</h1>
      {resource.phase === "annotating" && (
        <p className="notice">
          {t("player.translating")}
          {translating?.progress !== undefined && ` ${Math.round(translating.progress * 100)}%`}
        </p>
      )}
      <audio
        ref={audioRef}
        src={playbackUrl}
        controls
        preload="metadata"
        onLoadedMetadata={(event) => {
          event.currentTarget.playbackRate = rate;
          const resume = resource.lastPositionSec ?? 0;
          if (resume > 0) event.currentTarget.currentTime = resume;
        }}
      />
      <Transport rate={rate} onRate={setRate} loop={loop} onLoop={setLoop} />

      {transcript.length === 0 ? (
        <p className="notice">{t("player.noTranscript")}</p>
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
function Transport({
  rate,
  onRate,
  loop,
  onLoop,
}: {
  rate: number;
  onRate: (rate: number) => void;
  loop: boolean;
  onLoop: (loop: boolean) => void;
}) {
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

      {/* Drilling one hard sentence: hold the current Line until this goes off again,
          or a different Line becomes current — see the sampler effect above. */}
      <button
        type="button"
        className={`loop ${loop ? "on" : ""}`}
        aria-pressed={loop}
        title={t("player.repeatTitle")}
        onClick={() => onLoop(!loop)}
      >
        {t("player.repeat")}
      </button>

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
      <button className="ask" title={t("player.askTitle")} onClick={onAsk}>
        ?
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
    api
      .askStream(text, (chunk) => setAnswer((prev) => (prev ?? "") + chunk))
      .catch((failure: unknown) => setAnswer(reason(failure)));
  }, [text]);

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
