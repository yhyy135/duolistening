// The lyrics view: an <audio> element, a Transcript that follows it, and the ask-AI
// popup. Everything about "which Line is playing" comes from shared/locate.ts, which
// is pure and already tested — this file only turns its answer into DOM.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Line, Token } from "../shared/model.ts";
import { type Position, locate, tokenWords, wordSlices } from "../shared/locate.ts";
import { type PlayableResource, api, reason } from "./api.ts";

/** How long a manual scroll wins over the auto-scroll that follows playback. */
const SCROLL_GRACE_MS = 5000;

const NOWHERE: Position = { lineIndex: -1, wordIndex: null };

export function PlayerScreen({ id }: { id: string }) {
  const [data, setData] = useState<PlayableResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>(NOWHERE);
  const [asking, setAsking] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const scrollPausedUntil = useRef(0);
  // The ref, not the audio element: on unmount React may have detached it already,
  // and the last position is the one thing that must survive leaving the screen.
  const seconds = useRef(0);

  useEffect(() => {
    setData(null);
    setPosition(NOWHERE);
    api.resource(id).then(setData, (failure: unknown) => setError(reason(failure)));
  }, [id]);

  useEffect(
    () => () => {
      if (seconds.current > 0) void api.savePosition(id, seconds.current);
    },
    [id],
  );

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
      seconds.current = audio.currentTime;
      const next = locate(lines, audio.currentTime);
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

    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("seeked", sample);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("seeked", sample);
    };
  }, [data, id]);

  // Keep the current Line in view, unless the user is reading somewhere else.
  useEffect(() => {
    if (position.lineIndex < 0 || Date.now() < scrollPausedUntil.current) return;
    listRef.current?.children[position.lineIndex]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [position.lineIndex]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="notice">Loading…</p>;

  const { resource, transcript, playbackUrl } = data;
  const seek = (line: Line) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = line.startSec;
    void audio.play();
  };

  return (
    <main className="player">
      <h1>{resource.title}</h1>
      <audio
        ref={audioRef}
        src={playbackUrl}
        controls
        preload="metadata"
        onLoadedMetadata={(event) => {
          const resume = resource.lastPositionSec ?? 0;
          if (resume > 0) event.currentTarget.currentTime = resume;
        }}
      />

      {transcript.length === 0 ? (
        <p className="notice">No transcript yet.</p>
      ) : (
        <ol
          className="lyrics"
          ref={listRef}
          onWheel={() => (scrollPausedUntil.current = Date.now() + SCROLL_GRACE_MS)}
          onTouchMove={() => (scrollPausedUntil.current = Date.now() + SCROLL_GRACE_MS)}
        >
          {transcript.map((line, index) => (
            <LineRow
              key={index}
              line={line}
              current={index === position.lineIndex}
              wordIndex={index === position.lineIndex ? position.wordIndex : null}
              onSeek={() => seek(line)}
              onAsk={() => setAsking(line.text)}
            />
          ))}
        </ol>
      )}

      <AskDialog text={asking} onClose={() => setAsking(null)} />
    </main>
  );
}

function LineRow({
  line,
  current,
  wordIndex,
  onSeek,
  onAsk,
}: {
  line: Line;
  current: boolean;
  wordIndex: number | null;
  onSeek: () => void;
  onAsk: () => void;
}) {
  return (
    <li className={current ? "current" : ""} onClick={onSeek}>
      <p className="text">
        <LineText line={line} current={current} wordIndex={wordIndex} />
      </p>
      {line.translation && <p className="translation">{line.translation}</p>}
      <button
        className="ask"
        title="Ask about this line"
        onClick={(event) => {
          event.stopPropagation();
          onAsk();
        }}
      >
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

  useEffect(() => {
    if (!text) return;
    setAnswer(null);
    dialogRef.current?.showModal();
    api.ask(text).then(
      (reply) => setAnswer(reply.answer),
      (failure: unknown) => setAnswer(reason(failure)),
    );
  }, [text]);

  return (
    <dialog ref={dialogRef} className="ask-dialog" onClose={onClose}>
      <p className="text">{text}</p>
      <p className="answer">{answer ?? "Asking…"}</p>
      <button onClick={() => dialogRef.current?.close()}>Close</button>
    </dialog>
  );
}
