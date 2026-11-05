import {
  anyHmacMatches,
  assertAppId,
  assertTolerance,
  type Classification,
  concatBytes,
  DEFAULT_TAG_KEY,
  DEFAULT_TOLERANCE_SECONDS,
  type GuardResult,
  isRawBody,
  isRecord,
  parseJson,
  type RejectReason,
  toBytes,
  toGuardResult,
} from "./common.js";

export interface ResendGuardOptions {
  /** This app's id, as written into the outbound tag. */
  app: string;
  /** Domains this app receives on. Matched exactly, so list each subdomain. */
  receivingDomains?: readonly string[] | undefined;
  /** Domains this app sends from, including any shared ones. */
  sendingDomains?: readonly string[] | undefined;
  /** Sending domains several apps use. A domain here proves nothing, so only the tag counts. */
  sharedSendingDomains?: readonly string[] | undefined;
  /** Tag name holding the app id. Defaults to `app`. */
  tagName?: string | undefined;
}

export interface ResendEventLike {
  type?: unknown;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ResendTag {
  name: string;
  value: string;
}

export function resendTags(app: string, tagName: string = DEFAULT_TAG_KEY): ResendTag[] {
  assertAppId(app);
  return [{ name: tagName, value: app }];
}

export function tagResendEmail<P extends { tags?: ResendTag[] | undefined }>(
  app: string,
  params: P,
  tagName: string = DEFAULT_TAG_KEY,
): P {
  const [tag] = resendTags(app, tagName);
  const rest = (params.tags ?? []).filter((existing) => {
    if (existing.name !== tagName) return true;
    if (existing.value !== app) {
      throw new Error(`This email is already tagged ${existing.value}, so ${app} cannot claim it.`);
    }
    return false;
  });
  return { ...params, tags: [...rest, tag as ResendTag] };
}

const ADDRESS = String.raw`[^\s<>@,;:"()]+@[^\s<>@,;:"()]+`;
const ONE_ADDRESS = new RegExp(`^(?:(?:"[^"<>]*"\\s*|[^"<>@,;]*)<(${ADDRESS})>|(${ADDRESS}))$`);

/**
 * `Name <a@b.example>` or `a@b.example` to `a@b.example`. A display name never counts, and
 * anything that is not exactly one clean address gives null, so a crafted value proves nothing.
 */
function addressOf(value: string): string | null {
  const match = value.trim().match(ONE_ADDRESS);
  return (match?.[1] ?? match?.[2])?.toLowerCase() ?? null;
}

function domainOf(value: string): string | null {
  const address = addressOf(value);
  return address === null ? null : address.slice(address.lastIndexOf("@") + 1);
}

const lowered = (domains: readonly string[] | undefined) => new Set((domains ?? []).map((d) => d.toLowerCase()));

const stringsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/**
 * Inbound mail belongs to whichever app owns a recipient's domain. `received_for` is the
 * envelope, so it decides alone when present. `to` and `cc` are whatever the sender wrote.
 */
export function classifyReceivedEmail(email: Record<string, unknown>, options: ResendGuardOptions): Classification {
  const envelope = stringsIn(email.received_for);
  const recipients = envelope.length > 0 ? envelope : ["to", "cc", "bcc"].flatMap((field) => stringsIn(email[field]));
  if (recipients.length === 0) return { verdict: "untagged", reason: "no recipients on the message" };
  const ours = lowered(options.receivingDomains);
  const match = recipients.some((recipient) => {
    const domain = domainOf(recipient);
    return domain !== null && ours.has(domain);
  });
  return match
    ? { verdict: "ours", reason: "recipient on our receiving domain" }
    : { verdict: "foreign", reason: "no recipient on our receiving domains" };
}

function tagValue(tags: unknown, tagName: string): string | null {
  // Webhooks send tags as a map. The retrieve endpoint returns a list of name and value.
  if (Array.isArray(tags)) {
    const found = tags.find((tag) => isRecord(tag) && tag.name === tagName) as ResendTag | undefined;
    return typeof found?.value === "string" && found.value !== "" ? found.value : null;
  }
  if (!isRecord(tags)) return null;
  const value = tags[tagName];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Outbound mail: the tag decides when there is one, otherwise a domain only this app uses. */
export function classifySentEmail(email: Record<string, unknown>, options: ResendGuardOptions): Classification {
  const tag = tagValue(email.tags, options.tagName ?? DEFAULT_TAG_KEY);
  if (tag !== null) {
    return tag === options.app
      ? { verdict: "ours", reason: "tag matches" }
      : { verdict: "foreign", reason: `tagged for ${tag}` };
  }
  const domain = typeof email.from === "string" ? domainOf(email.from) : null;
  if (domain === null) return { verdict: "untagged", reason: "no from address" };
  if (lowered(options.sharedSendingDomains).has(domain)) {
    return { verdict: "untagged", reason: "shared sending domain and no tag" };
  }
  return lowered(options.sendingDomains).has(domain)
    ? { verdict: "ours", reason: "from our sending domain" }
    : { verdict: "foreign", reason: "from a domain we do not send from" };
}

export function classifyResendEvent(event: ResendEventLike, options: ResendGuardOptions): Classification {
  const type = typeof event.type === "string" ? event.type : "";
  const data = isRecord(event.data) ? event.data : {};
  if (type === "email.received") return classifyReceivedEmail(data, options);
  if (type.startsWith("email.")) return classifySentEmail(data, options);
  return { verdict: "untagged", reason: `${type || "unknown"} is an account-level event` };
}

export function onlyOurReceivedEmails<T>(items: readonly T[], options: ResendGuardOptions): T[] {
  return items.filter((item) => classifyReceivedEmail(item as Record<string, unknown>, options).verdict === "ours");
}

export function onlyOurSentEmails<T>(items: readonly T[], options: ResendGuardOptions): T[] {
  return items.filter((item) => classifySentEmail(item as Record<string, unknown>, options).verdict === "ours");
}

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeadersLike, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface ResendVerifyOptions {
  toleranceSeconds?: number | undefined;
  /** Current time in Unix seconds. For tests. */
  nowSeconds?: number | undefined;
}

/** Resend signs with Svix. This is Svix's manual check, with no SDK. Returns null when good. */
export async function verifyResendSignature(
  rawBody: string | Uint8Array,
  headers: HeadersLike,
  secret: string,
  options: ResendVerifyOptions = {},
): Promise<RejectReason | null> {
  const key = base64ToBytes(secret.trim().replace(/^whsec_/, ""));
  if (!key || key.length === 0) {
    throw new Error("The Resend webhook secret is empty or malformed. Check the app's environment.");
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  assertTolerance(tolerance);

  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signatures = header(headers, "svix-signature");
  if (!id || !timestamp || !signatures) return "missing-signature";
  if (!/^\d+$/.test(timestamp)) return "bad-signature";

  const candidates = signatures
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => base64ToBytes(entry.slice(3)))
    .filter((bytes) => bytes !== null);
  if (candidates.length === 0) return "bad-signature";

  const message = concatBytes(toBytes(`${id}.${timestamp}.`), toBytes(rawBody));
  if (!(await anyHmacMatches(key, message, candidates))) return "bad-signature";

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.abs(now - Number(timestamp)) > tolerance ? "stale-timestamp" : null;
}

export interface ResendWebhookInput extends ResendGuardOptions, ResendVerifyOptions {
  /** The exact bytes Resend sent. Read this before any JSON middleware runs. */
  rawBody: string | Uint8Array;
  /** Must include `svix-id`, `svix-timestamp` and `svix-signature`. */
  headers: HeadersLike;
  /** This webhook's `whsec_` signing secret. */
  secret: string;
}

export type ResendGuardResult = GuardResult<ResendEventLike> & { deliveryId?: string };

/** Verifies, then parses, then decides whose event it is, in that order. */
export async function guardResendWebhook(input: ResendWebhookInput): Promise<ResendGuardResult> {
  if (!isRawBody(input.rawBody)) return { action: "reject", status: 400, reason: "body-not-raw" };
  const failure = await verifyResendSignature(input.rawBody, input.headers, input.secret, input);
  if (failure) return { action: "reject", status: 400, reason: failure };
  const parsed = parseJson(input.rawBody);
  if (!parsed.ok) return { action: "reject", status: 400, reason: "malformed-json" };
  const event = parsed.value as ResendEventLike;
  // Resend events have no id of their own. svix-id stays the same across retries.
  const deliveryId = header(input.headers, "svix-id");
  const result = toGuardResult(event, classifyResendEvent(event, input), { eventId: deliveryId });
  // Object.assign, because a spread would drop the non-enumerable claim().
  return deliveryId ? Object.assign(result, { deliveryId }) : result;
}
