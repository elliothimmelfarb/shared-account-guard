/** Whose object or event this is, from one app's point of view. */
export type Verdict = "ours" | "foreign" | "untagged";

export interface Classification {
  verdict: Verdict;
  reason: string;
  /** For untagged Stripe objects: ids to fetch so the owner can be proven. */
  lookup?: Record<string, string>;
}

export type RejectReason =
  | "missing-signature"
  | "bad-signature"
  | "stale-timestamp"
  | "body-not-raw"
  | "malformed-json";

/** What a signature check found. A plain null or string here was too easy to read backwards. */
export type VerifyResult = { ok: true } | { ok: false; reason: RejectReason };

export type GuardResult<E> =
  /** Reply with `status`. The sender retries, so a real event is not lost to a misconfigured route. */
  | { action: "reject"; status: 400; reason: RejectReason }
  /** Another app's event. Reply 200. The payload is withheld on purpose. */
  | { action: "ignore"; status: 200; verdict: "foreign"; reason: string; eventId?: string; eventType?: string }
  /** Nobody can tell whose this is yet. Reply 200 unless you can prove ownership through `lookup`. */
  | {
      action: "ignore";
      status: 200;
      verdict: "untagged";
      reason: string;
      eventId?: string;
      eventType?: string;
      lookup: Record<string, string>;
      /**
       * The payload, which may be another app's personal data. Call this only after proving
       * ownership. It is a non-enumerable function, so JSON, spreads and loggers skip it.
       */
      claim(): E;
    }
  /** This app's event, verified. */
  | { action: "handle"; status: 200; event: E; eventId?: string; eventType?: string };

/**
 * Letters, digits, dashes and underscores only, because that is all Resend allows
 * in a tag value, and the same id should work on both accounts.
 */
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAppId(id: unknown): id is string {
  return typeof id === "string" && APP_ID.test(id);
}

export function assertAppId(id: string): void {
  if (!isValidAppId(id)) {
    throw new Error(`Invalid app id ${JSON.stringify(id)}: use 1 to 64 letters, digits, dashes or underscores.`);
  }
}

export const DEFAULT_TAG_KEY = "app";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function assertTolerance(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("The timestamp tolerance must be a finite number above 0, or the replay check turns off.");
  }
}

/** A tag value is written by whichever app tagged the object, so it must not be able to forge a log line. */
export function printableTag(tag: string): string {
  return tag.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, 64);
}

export function isRawBody(body: unknown): body is string | Uint8Array {
  return typeof body === "string" || body instanceof Uint8Array;
}

const encoder = new TextEncoder();

export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** True if any candidate is a valid HMAC-SHA256 of `message`. subtle.verify compares in constant time. */
export async function anyHmacMatches(key: Uint8Array, message: Uint8Array, candidates: Uint8Array[]): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let matched = false;
  for (const candidate of candidates) {
    if (await crypto.subtle.verify("HMAC", cryptoKey, candidate as BufferSource, message as BufferSource)) {
      matched = true;
    }
  }
  return matched;
}

export function parseJson(body: string | Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns a classification into the result a webhook route acts on. */
export function toGuardResult<E extends { id?: unknown; type?: unknown }>(
  event: E,
  c: Classification,
  extra: { eventId?: string | undefined } = {},
): GuardResult<E> {
  const eventId = extra.eventId ?? (typeof event.id === "string" ? event.id : undefined);
  const ids = {
    ...(eventId ? { eventId } : {}),
    ...(typeof event.type === "string" ? { eventType: event.type } : {}),
  };
  if (c.verdict === "ours") return { action: "handle", status: 200, event, ...ids };
  if (c.verdict === "foreign") return { action: "ignore", status: 200, verdict: "foreign", reason: c.reason, ...ids };
  const untagged = { action: "ignore", status: 200, verdict: "untagged", reason: c.reason, lookup: c.lookup ?? {}, ...ids };
  return Object.defineProperty(untagged, "claim", { value: () => event }) as unknown as GuardResult<E>;
}
