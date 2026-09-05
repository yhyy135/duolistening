import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Storage } from "../ports.ts";
import { assertValidKey, assertValidPrefix } from "./key.ts";

export interface S3StorageOptions {
  /**
   * Injected rather than built here, so pointing at MinIO / R2 / B2 is the
   * caller's `endpoint` setting and needs nothing from this module.
   */
  client: S3Client;
  bucket: string;
  /** Optional subtree, for sharing a bucket with something else. */
  keyPrefix?: string;
  /** Lifetime of the URLs handed to <audio>. Default 6 hours. */
  playbackUrlTtlSeconds?: number;
}

/** Storage backed by S3 or any S3-compatible service (ADR 0007). */
export function createS3Storage(options: S3StorageOptions): Storage {
  const { client, bucket } = options;
  const prefix = options.keyPrefix ? `${options.keyPrefix.replace(/\/$/, "")}/` : "";
  const ttl = options.playbackUrlTtlSeconds ?? 6 * 60 * 60;

  const remote = (key: string) => `${prefix}${key}`;
  const local = (key: string) => key.slice(prefix.length);

  return {
    async readDoc<T>(key: string): Promise<T | null> {
      assertValidKey(key);
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: remote(key) }),
        );
        const body = await response.Body?.transformToString();
        return body ? (JSON.parse(body) as T) : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async writeDoc<T>(key: string, value: T): Promise<void> {
      assertValidKey(key);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: remote(key),
          Body: JSON.stringify(value, null, 2),
          ContentType: "application/json",
        }),
      );
    },

    async listDocKeys(prefix_: string): Promise<string[]> {
      assertValidPrefix(prefix_);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: remote(prefix_),
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key?.endsWith(".json")) keys.push(local(object.Key));
        }
        token = page.NextContinuationToken;
      } while (token);
      return keys.sort();
    },

    async deleteObject(key: string): Promise<void> {
      assertValidKey(key);
      // S3 deletes are already idempotent — an absent key is a success.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: remote(key) }));
    },

    async writeMedia(key: string, localPath: string): Promise<void> {
      assertValidKey(key);
      // Multipart upload: audio runs to hundreds of megabytes and must not be
      // buffered into memory to be sent.
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: remote(key),
          Body: createReadStream(localPath),
          ContentType: "audio/mp4",
        },
      }).done();
    },

    async readMediaToFile(key: string, destPath: string): Promise<void> {
      assertValidKey(key);
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: remote(key) }),
      );
      if (!response.Body) throw new Error(`No body for media key: ${key}`);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await pipeline(response.Body as Readable, createWriteStream(destPath));
    },

    async playbackUrl(key: string): Promise<string> {
      assertValidKey(key);
      // Presigned, so the browser streams and seeks against the bucket directly
      // and none of the audio traffic passes through this process.
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: remote(key) }), {
        expiresIn: ttl,
      });
    },
  };
}

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404;
}
