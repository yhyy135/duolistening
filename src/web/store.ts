import type { Resource, ResourceId, Settings, Transcript } from "../shared/model.ts";
import type { BackupEntry } from "./backup.ts";

/**
 * Everything the browser keeps (ADR 0008). This is the whole persistence layer —
 * what used to be `library.ts`, `settings.ts` and two `Storage` adapters behind a
 * seam now that there is nothing on a server to hide.
 *
 * Plain functions, not an interface with a factory: there is exactly one
 * implementation and there will not be a second, since the alternative storage this
 * once abstracted over (a filesystem, S3) is on the machine we no longer have.
 *
 * Two invariants the old two-adapter design had to work for are simply gone.
 * `library.ts` wrote blobs before the shelf and deleted them after it, so that a
 * crash halfway left unreachable bytes rather than a shelf row pointing at nothing;
 * one IndexedDB transaction writes all three stores or none, so there is no halfway.
 * And its in-process write mutex — a `ponytail:` shortcut whose ceiling was
 * multi-instance deployment — is what transactions are.
 *
 * Nothing here runs at import time, so `node --test` can load this file for the pure
 * half below without an `indexedDB` to open.
 */

const DB_NAME = "duolistening";
const DB_VERSION = 1;
const SETTINGS_KEY = "settings";

/** One store each, all keyed by ResourceId except settings, which is a single row. */
const STORES = ["settings", "resources", "transcripts", "audio"] as const;
type StoreName = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  // Opened once and reused: every call below would otherwise pay the upgrade check,
  // and a second open blocks while the first is upgrading.
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Another tab is holding an older version of the database open."));
  });
  return opening;
}

/**
 * One transaction over `names`, resolved when it *commits* rather than when the last
 * request succeeds — a write that is merely acknowledged has not been kept yet.
 *
 * `body` must not await anything outside IndexedDB: a transaction closes itself as
 * soon as its request queue empties, so an unrelated `await` in the middle ends it
 * and every later request in the same transaction throws.
 */
async function tx<T>(
  names: readonly StoreName[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => T,
): Promise<T> {
  // Spread because `transaction()` wants a mutable array, and STORES is `as const`
  // so that a typo in a store name is a type error rather than a runtime one.
  const transaction = (await db()).transaction([...names], mode);
  const result = body(transaction);

  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(quotaAware(transaction.error));
    transaction.onabort = () => reject(quotaAware(transaction.error));
  });
}

/**
 * There is no quota gauge in the UI (ADR 0008 — the two engines measured disagreed
 * by a factor of eighty, and a number nobody can act on earns no screen space), so a
 * full disk announces itself here and nowhere else. It has to read as running out of
 * room, not as a mysteriously broken import.
 */
function quotaAware(error: DOMException | null): Error {
  if (error?.name === "QuotaExceededError") {
    return new Error("This browser is out of storage space. Delete an episode and try again.");
  }
  return error ?? new Error("The database rejected the write.");
}

function value<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------- settings

export async function readSettings(): Promise<Settings | undefined> {
  const store = (await db()).transaction("settings", "readonly").objectStore("settings");
  return value(store.get(SETTINGS_KEY));
}

export function writeSettings(settings: Settings): Promise<void> {
  return tx(["settings"], "readwrite", (transaction) => {
    transaction.objectStore("settings").put(settings, SETTINGS_KEY);
  });
}

// ---------------------------------------------------------------- the shelf

export async function listResources(): Promise<Resource[]> {
  await claimPendingPosition();
  const store = (await db()).transaction("resources", "readonly").objectStore("resources");
  const all = await value(store.getAll() as IDBRequest<Resource[]>);
  // Newest first, which is the order the shelf renders in.
  return all.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
}

export async function getResource(id: ResourceId): Promise<Resource | undefined> {
  // Also here, not only in listResources: opening a deep link to the player never
  // touches the shelf, and that is exactly the path someone resuming takes.
  await claimPendingPosition();
  const store = (await db()).transaction("resources", "readonly").objectStore("resources");
  return value(store.get(id));
}

export async function getTranscript(id: ResourceId): Promise<Transcript | undefined> {
  const store = (await db()).transaction("transcripts", "readonly").objectStore("transcripts");
  return value(store.get(id));
}

/**
 * The Blob is stored with its type already corrected, so this hands back something
 * `URL.createObjectURL` can be pointed at directly. Absent means the audio was never
 * fetched or was restored from a backup, which carries Transcripts and not audio.
 */
export async function getAudio(id: ResourceId): Promise<Blob | undefined> {
  const store = (await db()).transaction("audio", "readonly").objectStore("audio");
  return value(store.get(id));
}

/** Resource, Transcript and audio together or not at all. */
export function save(entry: {
  resource: Resource;
  transcript?: Transcript;
  audio?: Blob;
}): Promise<void> {
  return tx(["resources", "transcripts", "audio"], "readwrite", (transaction) => {
    transaction.objectStore("resources").put(entry.resource, entry.resource.id);
    if (entry.transcript) {
      transaction.objectStore("transcripts").put(entry.transcript, entry.resource.id);
    }
    if (entry.audio) transaction.objectStore("audio").put(entry.audio, entry.resource.id);
  });
}

/**
 * The Lines on their own, without the Resource row beside them.
 *
 * `save` above writes both, and the caller would have to hand back a Resource it read
 * when the screen opened — clobbering the `lastPositionSec` written under it since.
 * Translation now lands while something is playing (ADR 0011), so those two writers
 * are live at the same time.
 */
export function saveTranscript(id: ResourceId, transcript: Transcript): Promise<void> {
  return tx(["transcripts"], "readwrite", (transaction) => {
    transaction.objectStore("transcripts").put(transcript, id);
  });
}

/**
 * Called from `timeupdate`, so several times a minute for as long as something is
 * playing. It touches one row and never reads the Transcript or audio beside it.
 */
export async function savePosition(id: ResourceId, seconds: number): Promise<void> {
  const database = await db();
  const store = database.transaction("resources", "readwrite").objectStore("resources");
  const resource = await value<Resource | undefined>(store.get(id));
  if (!resource) return;
  await value(store.put({ ...resource, lastPositionSec: seconds }, id));
}

/**
 * The last position, parked somewhere a closing page can still write to.
 *
 * `savePosition` is asynchronous, and a transaction opened as the page tears down is
 * not reliably committed — which is the same hole `navigator.sendBeacon` used to
 * plug, back when a position was a POST. There is no beacon for IndexedDB. But
 * `localStorage` is synchronous, and this is the one situation where that is the
 * feature rather than the cost: the write lands before the page is gone.
 *
 * One key, not one per Resource: only the episode being listened to can be the one
 * whose page is closing.
 */
const PENDING_POSITION = "duolistening.pendingPosition";

export function flushPosition(id: ResourceId, seconds: number): void {
  try {
    localStorage.setItem(PENDING_POSITION, JSON.stringify({ id, seconds }));
  } catch {
    // Private modes can refuse to store. Losing a resume point is not worth throwing
    // from inside a pagehide handler over.
  }
}

/**
 * Folds a parked position back into the Library. Called from the reads below rather
 * than left to a caller to remember, because forgetting it loses exactly the thing
 * it exists to save, and silently.
 */
async function claimPendingPosition(): Promise<void> {
  let parked: { id?: unknown; seconds?: unknown } | null = null;
  try {
    parked = JSON.parse(localStorage.getItem(PENDING_POSITION) ?? "null");
  } catch {
    parked = null;
  }
  if (!parked || typeof parked.id !== "string" || typeof parked.seconds !== "number") return;
  // Cleared first: a claim that throws must not be retried forever on every read.
  try {
    localStorage.removeItem(PENDING_POSITION);
  } catch {
    // See above.
  }
  await savePosition(parked.id, parked.seconds);
}

/** Cascades over all three stores in one transaction. */
export function remove(id: ResourceId): Promise<void> {
  return tx(["resources", "transcripts", "audio"], "readwrite", (transaction) => {
    transaction.objectStore("resources").delete(id);
    transaction.objectStore("transcripts").delete(id);
    transaction.objectStore("audio").delete(id);
  });
}

/**
 * Everything an export needs, read in one pass. `buildBackup` drops the entries whose
 * Resource is not `ready`; they are gathered here anyway so it can report them.
 */
export async function allEntries(): Promise<BackupEntry[]> {
  const database = await db();
  const transaction = database.transaction(["resources", "transcripts"], "readonly");
  const resources = await value(
    transaction.objectStore("resources").getAll() as IDBRequest<Resource[]>,
  );
  const entries: BackupEntry[] = [];
  for (const resource of resources) {
    const transcript = await value<Transcript | undefined>(
      database
        .transaction("transcripts", "readonly")
        .objectStore("transcripts")
        .get(resource.id),
    );
    if (transcript) entries.push({ resource, transcript });
  }
  return entries;
}

// ---------------------------------------------------------------- audio typing

/** What the magic bytes say, for the formats a podcast enclosure is ever in. */
const SIGNATURES: [string, (head: Uint8Array) => boolean][] = [
  // ID3v2 tag, then MPEG frames. Overwhelmingly the common podcast shape.
  ["audio/mpeg", (h) => h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33],
  // A bare MPEG frame sync: eleven set bits. No ID3 tag in front of it. The `?? 0`
  // is not decoration — a Blob shorter than two bytes has no second byte, and an
  // absent one must fail the mask rather than throw on its way through it.
  ["audio/mpeg", (h) => h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0],
  ["audio/mp4", (h) => ascii(h, 4, 8) === "ftyp"],
  ["audio/ogg", (h) => ascii(h, 0, 4) === "OggS"],
  ["audio/wav", (h) => ascii(h, 0, 4) === "RIFF" && ascii(h, 8, 12) === "WAVE"],
  ["audio/flac", (h) => ascii(h, 0, 4) === "fLaC"],
];

/**
 * The type an audio Blob is stored under, and the single reason Safari can play what
 * this app imports.
 *
 * The bytes win over the declaration, which is the whole finding: a real server
 * answered `audio/mp4a-latm` — specific, confident and wrong — for files that were
 * MPEG throughout, because the pipeline had named them `.m4a`. Chrome sniffs content
 * and hid it completely; Safari believes the label and refuses with
 * `MEDIA_ERR_SRC_NOT_SUPPORTED`, unless an `ID3` header happens to be magic enough to
 * override it, so whether an episode played came down to coincidence. Preferring the
 * declaration whenever it looks specific would reproduce the bug exactly.
 *
 * The declaration is still the fallback: it is better than nothing for a format these
 * signatures do not know, and an empty string is better than a confident wrong guess.
 */
export function audioType(declared: string | null | undefined, head: Uint8Array): string {
  for (const [type, matches] of SIGNATURES) {
    if (matches(head)) return type;
  }
  const bare = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  // Nothing recognised the bytes and the server only said "some binary file".
  if (!bare || bare === "application/octet-stream" || bare === "binary/octet-stream") return "";
  return bare;
}

/** Re-labels a downloaded Blob before it is stored, so `blob.type` is never a lie. */
export async function typedAudio(response: Blob, declared?: string | null): Promise<Blob> {
  const head = new Uint8Array(await response.slice(0, 12).arrayBuffer());
  const type = audioType(declared ?? response.type, head);
  return type === response.type ? response : new Blob([response], { type });
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.slice(from, to));
}
