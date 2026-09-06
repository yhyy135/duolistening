import {
  storageKeys,
  type Resource,
  type ResourceId,
  type Transcript,
} from "../shared/model.ts";
import type { Library, Storage } from "./ports.ts";

/**
 * The Library over a Storage seam.
 *
 * Two ordering rules hold everything together, and they are deliberately mirror
 * images: `save` writes the blobs before the shelf, `remove` rewrites the shelf
 * before deleting the blobs. Either way a crash halfway leaves unreachable bytes
 * — never a shelf entry pointing at something that isn't there.
 */
export function createLibrary(storage: Storage): Library {
  // ponytail: an in-process promise chain is the whole concurrency story. It holds
  // because one process serves one user (ADR 0001); a second instance writing the
  // same shelf would lose updates. Move the shelf into a store with compare-and-set
  // if that day comes.
  let tail: Promise<unknown> = Promise.resolve();
  function serialised<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  const readShelf = async (): Promise<Resource[]> =>
    (await storage.readDoc<Resource[]>(storageKeys.index)) ?? [];

  /** Read-modify-write of the shelf, serialised so concurrent edits can't drop each other. */
  const editShelf = (edit: (shelf: Resource[]) => Resource[] | null): Promise<void> =>
    serialised(async () => {
      const next = edit(await readShelf());
      if (next) await storage.writeDoc(storageKeys.index, next);
    });

  return {
    list: readShelf,

    async get(id: ResourceId) {
      const resource = (await readShelf()).find((candidate) => candidate.id === id);
      if (!resource) return null;
      // Absent while the import is still running — an empty Transcript, not an error.
      const transcript = (await storage.readDoc<Transcript>(storageKeys.transcript(id))) ?? [];
      return { resource, transcript };
    },

    async save(resource, parts) {
      if (parts?.audioPath) {
        await storage.writeMedia(storageKeys.audio(resource.id), parts.audioPath);
      }
      if (parts?.transcript) {
        await storage.writeDoc(storageKeys.transcript(resource.id), parts.transcript);
      }
      // Shelf last: it is what makes the Resource visible.
      await editShelf((shelf) => {
        const rest = shelf.filter((candidate) => candidate.id !== resource.id);
        return [resource, ...rest];
      });
    },

    async remove(id: ResourceId) {
      // Shelf first: the entry disappears immediately, so nothing can be handed a
      // Resource whose files are already on their way out.
      await editShelf((shelf) => shelf.filter((candidate) => candidate.id !== id));
      await storage.deleteObject(storageKeys.transcript(id));
      await storage.deleteObject(storageKeys.audio(id));
    },

    async restoreAudio(id: ResourceId, destPath: string): Promise<boolean> {
      try {
        await storage.readMediaToFile(storageKeys.audio(id), destPath);
        return true;
      } catch {
        // Absent is the expected answer here — an import that died before the audio
        // was stored leaves none — and the adapters report it as a throw with an
        // adapter-specific shape. Sniffing for ENOENT vs NoSuchKey would put S3's
        // vocabulary in this file to distinguish "gone" from "storage is having a
        // moment", and both answers lead the caller to the same place: fetch it again.
        return false;
      }
    },

    async savePosition(id: ResourceId, seconds: number) {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Invalid playback position: ${seconds}`);
      }
      await editShelf((shelf) => {
        const index = shelf.findIndex((candidate) => candidate.id === id);
        if (index === -1) return null;
        const next = [...shelf];
        next[index] = { ...(shelf[index] as Resource), lastPositionSec: seconds };
        return next;
      });
    },
  };
}
