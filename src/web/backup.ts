import type { Favorite, Resource, ResourceId, Settings, Transcript } from "../shared/model.ts";

/**
 * Export and import of everything the browser holds (ADR 0008).
 *
 * This exists because `navigator.storage.persist()` was refused by every engine
 * tested, so nothing stops a browser evicting the Library under disk pressure. The
 * export is therefore not a convenience — it is the durability story, and the
 * reason it ships before anything else is written to IndexedDB.
 *
 * Pure on purpose: no IndexedDB, no DOM, no fetch. The store hands it plain objects
 * and takes plain objects back, which is what lets the interesting half — validating
 * a file someone hands us — be tested in `node --test` alongside everything else.
 */

export const BACKUP_FORMAT = "duolistening-backup";
export const BACKUP_VERSION = 1;

export interface BackupEntry {
  resource: Resource;
  transcript: Transcript;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO 8601. */
  exportedAt: string;
  /** Absent unless the reader asked for it, and never carrying keys unless they asked twice. */
  settings?: Settings;
  entries: BackupEntry[];
  /**
   * Absent from a file written before favorites existed, which reads as none. Added
   * without moving `BACKUP_VERSION`: an older build rebuilds the envelope from the
   * fields it knows, so it still restores a newer file's episodes and skips the stars,
   * where a bump would have it refuse the whole file.
   */
  favorites?: Favorite[];
}

export interface BuildInput {
  entries: BackupEntry[];
  favorites?: Favorite[];
  settings?: Settings;
  /**
   * Off by default, and deliberately awkward to turn on. A backup lands in cloud
   * storage or an email attachment, and [ADR 0008] has just made these keys a real
   * per-reader secret rather than a shared deployment password.
   */
  includeKeys?: boolean;
  exportedAt?: string;
}

/**
 * Audio is not in here. It is roughly forty-five times the size of the Transcript
 * beside it and it can be fetched again from `source.episodeUrl`, while a Transcript
 * costs real money to produce a second time. A backup carrying every episode's audio
 * would be gigabytes, which is not a file anyone actually keeps.
 */
export function buildBackup(input: BuildInput): { backup: Backup; excluded: Resource[] } {
  // Only finished Resources. A half-imported one holds nothing expensive, and
  // restoring `phase: "transcribing"` would put a progress bar on the shelf for a
  // job that does not exist and can never finish.
  const ready = input.entries.filter((entry) => entry.resource.phase === "ready");
  const excluded = input.entries
    .filter((entry) => entry.resource.phase !== "ready")
    .map((entry) => entry.resource);

  return {
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: input.exportedAt ?? new Date().toISOString(),
      ...(input.settings && {
        settings: forExport(input.settings, input.includeKeys ?? false),
      }),
      entries: ready,
      ...(input.favorites && input.favorites.length > 0 && { favorites: input.favorites }),
    },
    excluded,
  };
}

/**
 * Every secret in Settings, blanked. Add a field here the moment one joins Settings:
 * the proxy key was missed on its way in, and an export is a plaintext file that ends
 * up in cloud storage, so a secret that slips through does not slip back.
 *
 * `backup.test.ts` looks for the values themselves rather than checking these three
 * names, so the next one added without a line here fails the suite rather than
 * shipping.
 */
function forExport(settings: Settings, includeKeys: boolean): Settings {
  if (includeKeys) return settings;
  return {
    ...settings,
    textModel: { ...settings.textModel, apiKey: "" },
    transcriptionModel: { ...settings.transcriptionModel, apiKey: "" },
    ...(settings.proxy && { proxy: { ...settings.proxy, key: "" } }),
  };
}

export type ParseResult =
  { ok: true; backup: Backup; skipped: string[] } | { ok: false; problem: string };

/**
 * Reads a file the reader chose. Everything in it is untrusted — it may be the wrong
 * file entirely, a truncated download, or hand-edited.
 *
 * A bad envelope refuses the whole file, because nothing below it can be trusted
 * either. A bad *entry* is dropped and named instead: someone importing because
 * their Library was evicted wants the forty-nine good episodes, and refusing all
 * fifty over one corrupt record is the least useful thing this could do.
 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "That file is not JSON." };
  }
  if (!isRecord(raw)) return { ok: false, problem: "That file is not a backup." };
  if (raw.format !== BACKUP_FORMAT) {
    return { ok: false, problem: "That file was not written by duolistening." };
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, problem: "That backup has no usable version number." };
  }
  // Refused outright rather than read optimistically: a newer writer may have moved
  // a field this version would read as absent, and a silent half-import of someone's
  // only copy is worse than being told to upgrade.
  if (raw.version > BACKUP_VERSION) {
    return {
      ok: false,
      problem: `That backup is version ${raw.version}, and this build reads up to ${BACKUP_VERSION}. Update first.`,
    };
  }
  if (!Array.isArray(raw.entries)) return { ok: false, problem: "That backup has no entries." };

  const entries: BackupEntry[] = [];
  const skipped: string[] = [];
  for (const [index, candidate] of raw.entries.entries()) {
    const entry = validEntry(candidate);
    if (entry) entries.push(entry);
    else skipped.push(describe(candidate, index));
  }
  const favorites = Array.isArray(raw.favorites) ? raw.favorites.flatMap(validFavorite) : [];

  return {
    ok: true,
    skipped,
    backup: {
      format: BACKUP_FORMAT,
      version: raw.version,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      ...(isRecord(raw.settings) && { settings: raw.settings as unknown as Settings }),
      entries,
      ...(favorites.length > 0 && { favorites }),
    },
  };
}

/**
 * What an import would do, decided before anything is written so the reader can be
 * shown it first.
 *
 * An id already on the shelf is skipped, never merged and never overwritten. Ids are
 * generated per import, so a collision means the same Resource — and the copy already
 * here may have a playback position or a repaired Transcript the file does not. One
 * rule, no reconciliation, and no way for an import to destroy something.
 */
export interface ImportPlan {
  add: BackupEntry[];
  alreadyHere: { id: ResourceId; title: string }[];
  /**
   * The file's favorites this browser does not have. One it has is left as it is rather
   * than overwritten, which keeps the date it was starred here, and with it its place.
   */
  favorites: Favorite[];
  settings?: Settings;
}

export function planImport(
  existing: Iterable<ResourceId>,
  backup: Backup,
  options: {
    restoreSettings?: boolean;
    /** The feed URLs already starred here. */
    favorited?: Iterable<string>;
  } = {},
): ImportPlan {
  const have = new Set(existing);
  const add: BackupEntry[] = [];
  const alreadyHere: { id: ResourceId; title: string }[] = [];

  for (const entry of backup.entries) {
    if (have.has(entry.resource.id)) {
      alreadyHere.push({ id: entry.resource.id, title: entry.resource.title });
    } else {
      add.push(entry);
      // A file listing the same id twice must not queue it twice.
      have.add(entry.resource.id);
    }
  }

  const starred = new Set(options.favorited);
  const favorites = (backup.favorites ?? []).filter((favorite) => {
    if (starred.has(favorite.feedUrl)) return false;
    starred.add(favorite.feedUrl);
    return true;
  });

  return {
    add,
    alreadyHere,
    favorites,
    ...(options.restoreSettings && backup.settings && { settings: backup.settings }),
  };
}

/**
 * Whether a re-fetched audio file still matches the Transcript that was made from it.
 *
 * Worth checking because at least one real podcast host splices advertising per
 * request: the same episode URL answered one client with 43,421,257 bytes and another
 * with 44,263,131, thirty seconds apart. Restore a Transcript, re-download the audio,
 * and every timestamp in it can be wrong by an ad break — which reads as "this episode
 * is subtly broken" rather than as anything diagnosable. One second of slack absorbs
 * the disagreement between a container's header and a decoder's own count.
 */
export function audioMatches(expectedSec: number, actualSec: number): boolean {
  return Math.abs(expectedSec - actualSec) <= 1;
}

/** `duolistening-backup-2026-09-08.json` — sorts chronologically in a downloads folder. */
export function backupFilename(exportedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] ?? "undated";
  return `duolistening-backup-${day}.json`;
}

function validEntry(candidate: unknown): BackupEntry | null {
  if (!isRecord(candidate)) return null;
  const { resource, transcript } = candidate;
  if (!isRecord(resource) || !isRecord(resource.source)) return null;
  if (typeof resource.id !== "string" || !resource.id) return null;
  if (typeof resource.title !== "string") return null;
  if (typeof resource.durationSec !== "number" || !Number.isFinite(resource.durationSec)) {
    return null;
  }
  // The Transcript is the whole point of the file. An entry without one is a shelf
  // row for an episode whose expensive half is missing, which is not worth restoring.
  if (!Array.isArray(transcript) || transcript.length === 0) return null;
  if (!transcript.every(isLine)) return null;

  return {
    resource: resource as unknown as Resource,
    transcript: transcript as unknown as Transcript,
  };
}

/**
 * Rebuilt field by field rather than cast. The file is untrusted, and two of these
 * fields leave the page: the feed URL becomes a request through the reader's proxy, and
 * the cover an `<img src>` — so neither is taken unless it is http(s).
 */
function validFavorite(candidate: unknown): Favorite[] {
  if (!isRecord(candidate)) return [];
  const { feedUrl, title, author, artworkUrl, addedAt } = candidate;
  if (!isWebUrl(feedUrl) || typeof title !== "string") return [];
  return [
    {
      feedUrl,
      title,
      ...(typeof author === "string" && author && { author }),
      ...(isWebUrl(artworkUrl) && { artworkUrl }),
      addedAt: typeof addedAt === "string" ? addedAt : "",
    },
  ];
}

function isWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isLine(candidate: unknown): boolean {
  return (
    isRecord(candidate) &&
    typeof candidate.text === "string" &&
    typeof candidate.startSec === "number" &&
    typeof candidate.endSec === "number"
  );
}

function describe(candidate: unknown, index: number): string {
  const title = isRecord(candidate) && isRecord(candidate.resource) && candidate.resource.title;
  return typeof title === "string" && title ? title : `entry ${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
