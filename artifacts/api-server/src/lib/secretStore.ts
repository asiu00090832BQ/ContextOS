import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Minimal secret store for sensitive credential material (e.g. model endpoint
 * API keys). Raw secret values are kept OUT of application database rows; the
 * database persists only an opaque reference (e.g. "secret://<uuid>") returned
 * by `putSecret`. The actual values live in a separate, access-restricted store
 * file so that credentials are never co-located with tenant data.
 *
 * Concurrency / integrity:
 * - `putSecret`/`deleteSecret` are fully synchronous (read -> mutate -> write)
 *   and contain no `await`. Because this process is single-threaded, the event
 *   loop cannot interleave another caller in the middle of one of these calls,
 *   so the read-modify-write is effectively serialized — two "concurrent"
 *   requests run their mutations one after the other and neither can be lost.
 * - Writes are crash-safe: the new contents are written to a temp file and then
 *   atomically renamed over the target, so a crash mid-write cannot corrupt or
 *   truncate the store.
 * - Reads fail loud: a missing file is treated as empty, but a present-but-
 *   unreadable/corrupt file throws instead of silently returning {} (which would
 *   otherwise let a subsequent write wipe every stored secret).
 */

const REF_PREFIX = "secret://";

const STORE_PATH = resolve(
  process.env.MODEL_SECRET_STORE_PATH ?? ".local/state/model-secrets.json",
);

type SecretMap = Record<string, string>;

function load(): SecretMap {
  if (!existsSync(STORE_PATH)) return {};
  // Intentionally NOT wrapped in try/catch: if the file exists but cannot be
  // read or parsed, surfacing the error prevents a follow-up write from
  // overwriting the store with an empty map and destroying live secrets.
  return JSON.parse(readFileSync(STORE_PATH, "utf8")) as SecretMap;
}

function persist(map: SecretMap): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  renameSync(tmp, STORE_PATH);
}

export function isSecretRef(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(REF_PREFIX);
}

/**
 * Store a raw secret value and return an opaque reference to persist in the DB.
 * When `existingRef` is provided and valid, the secret is rotated in place so
 * the reference remains stable.
 */
export function putSecret(
  rawValue: string,
  existingRef?: string | null,
): string {
  const ref = isSecretRef(existingRef)
    ? (existingRef as string)
    : `${REF_PREFIX}${randomUUID()}`;
  const map = load();
  map[ref] = rawValue;
  persist(map);
  return ref;
}

/** Resolve a reference back to its raw secret value, or null if unknown. */
export function resolveSecret(ref: string | null | undefined): string | null {
  if (!isSecretRef(ref)) return null;
  const map = load();
  return map[ref as string] ?? null;
}

/** Delete a stored secret by reference (no-op for non-references). */
export function deleteSecret(ref: string | null | undefined): void {
  if (!isSecretRef(ref)) return;
  const map = load();
  if (ref && ref in map) {
    delete map[ref];
    persist(map);
  }
}
