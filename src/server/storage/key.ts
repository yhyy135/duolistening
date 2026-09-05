// Storage keys arrive carrying ids that came off a URL, so they are untrusted
// input at a trust boundary: on the local adapter a key containing `..` escapes
// the storage root entirely. Both adapters validate, so neither can be the weak one.

function assertSafeSegments(value: string, label: string): void {
  if (value.includes("\0") || value.includes("\\") || value.includes("//")) {
    throw new Error(`Invalid storage ${label}: ${JSON.stringify(value)}`);
  }
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`Invalid storage ${label}: ${JSON.stringify(value)}`);
    }
  }
}

/** A key names one object: non-empty, relative, no trailing slash. */
export function assertValidKey(key: string): void {
  if (key.length === 0 || key.startsWith("/") || key.endsWith("/")) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  assertSafeSegments(key, "key");
}

/** A prefix names a subtree: may be empty (everything) and may end in a slash. */
export function assertValidPrefix(prefix: string): void {
  if (prefix.startsWith("/")) {
    throw new Error(`Invalid storage prefix: ${JSON.stringify(prefix)}`);
  }
  assertSafeSegments(prefix, "prefix");
}
