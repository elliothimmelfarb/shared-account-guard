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

export interface StripeGuardOptions {
  /** This app's id, as written into `metadata`. */
  app: string;
  /** Metadata key holding the app id. Defaults to `app`. */
  tagKey?: string | undefined;
}

export interface StripeEventLike {
  id?: unknown;
  type?: unknown;
  object?: unknown;
  data?: { object?: unknown } | null;
  related_object?: { id?: unknown } | null;
  [key: string]: unknown;
}

/** The metadata block for any object an app creates. */
export function stripeTag(app: string, tagKey: string = DEFAULT_TAG_KEY): Record<string, string> {
  assertAppId(app);
  return { [tagKey]: app };
}

function mergeTag(
  app: string,
  tagKey: string,
  metadata: Record<string, string> | null | undefined,
): Record<string, string> {
  const existing = metadata?.[tagKey];
  if (existing !== undefined && existing !== app) {
    throw new Error(`This object is already tagged ${existing}, so ${app} cannot claim it.`);
  }
  return { ...metadata, ...stripeTag(app, tagKey) };
}

type Nested = { metadata?: Record<string, string> | null } & Record<string, unknown>;

export interface CheckoutSessionParamsLike {
  mode?: string | null;
  metadata?: Record<string, string> | null;
  payment_intent_data?: Nested;
  subscription_data?: Nested;
  setup_intent_data?: Nested;
  [key: string]: unknown;
}

const NESTED_FIELD = {
  payment: "payment_intent_data",
  subscription: "subscription_data",
  setup: "setup_intent_data",
} as const;

/**
 * Tags a Checkout Session and the object it creates. Metadata on the session
 * does not reach that object on its own, and each mode accepts only its own field.
 */
export function tagCheckoutSession<P extends CheckoutSessionParamsLike>(
  app: string,
  params: P,
  tagKey: string = DEFAULT_TAG_KEY,
): P & CheckoutSessionParamsLike {
  const field = NESTED_FIELD[params.mode as keyof typeof NESTED_FIELD];
  if (!field) throw new Error("tagCheckoutSession needs mode: payment, subscription or setup.");
  const nested: Nested = params[field] ?? {};
  return {
    ...params,
    metadata: mergeTag(app, tagKey, params.metadata),
    [field]: { ...nested, metadata: mergeTag(app, tagKey, nested.metadata) },
  };
}

function tagFrom(metadata: unknown, tagKey: string): string | null {
  if (!isRecord(metadata)) return null;
  const value = metadata[tagKey];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Every place a tag can sit on an object, including an invoice's copy of its subscription's metadata. */
function tagsOn(object: Record<string, unknown>, tagKey: string): string[] {
  const blocks: unknown[] = [object.metadata];
  const parent = object.parent;
  if (isRecord(parent) && isRecord(parent.subscription_details)) blocks.push(parent.subscription_details.metadata);
  if (isRecord(object.subscription_details)) blocks.push(object.subscription_details.metadata);
  const lines = object.lines;
  if (isRecord(lines) && Array.isArray(lines.data)) {
    for (const line of lines.data) if (isRecord(line)) blocks.push(line.metadata);
  }
  return blocks.map((block) => tagFrom(block, tagKey)).filter((tag) => tag !== null);
}

const LOOKUP_FIELDS = ["payment_intent", "charge", "invoice", "subscription", "setup_intent", "customer"];

function lookupIds(object: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const field of LOOKUP_FIELDS) {
    const value = object[field];
    if (typeof value === "string") ids[field] = value;
    else if (isRecord(value) && typeof value.id === "string") ids[field] = value.id;
  }
  return ids;
}

export function classifyStripeObject(object: unknown, options: StripeGuardOptions): Classification {
  if (!isRecord(object)) return { verdict: "untagged", reason: "no object to read", lookup: {} };
  const tags = tagsOn(object, options.tagKey ?? DEFAULT_TAG_KEY);
  const other = tags.find((tag) => tag !== options.app);
  if (other !== undefined) return { verdict: "foreign", reason: `tagged for ${other}` };
  if (tags.length > 0) return { verdict: "ours", reason: "tag matches" };
  return { verdict: "untagged", reason: "object carries no app tag", lookup: lookupIds(object) };
}

export function classifyStripeEvent(event: StripeEventLike, options: StripeGuardOptions): Classification {
  if (event.object === "v2.core.event") {
    const id = isRecord(event.related_object) ? event.related_object.id : undefined;
    return {
      verdict: "untagged",
      reason: "thin events carry no metadata",
      lookup: typeof id === "string" ? { related_object: id } : {},
    };
  }
  return classifyStripeObject(event.data?.object, options);
}

export function onlyOurStripeObjects<T>(items: readonly T[], options: StripeGuardOptions): T[] {
  return items.filter((item) => classifyStripeObject(item, options).verdict === "ours");
}

export interface StripeVerifyOptions {
  toleranceSeconds?: number | undefined;
  /** Current time in Unix seconds. For tests. */
  nowSeconds?: number | undefined;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) as string[], (byte) => parseInt(byte, 16));
}

/**
 * Stripe's manual verification, with no SDK. Returns null when the signature is
 * good. Only `v1` counts: any other scheme is skipped to prevent a downgrade.
 */
export async function verifyStripeSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: StripeVerifyOptions = {},
): Promise<RejectReason | null> {
  if (!secret || secret.trim() === "" || secret === "whsec_") {
    throw new Error("The Stripe webhook secret is empty. Check the app's environment.");
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  assertTolerance(tolerance);
  if (!header) return "missing-signature";

  let timestamp: string | undefined;
  const candidates: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === "t") timestamp = value;
    else if (name === "v1") {
      const bytes = hexToBytes(value);
      if (bytes) candidates.push(bytes);
    }
  }
  if (timestamp === undefined || !/^\d+$/.test(timestamp) || candidates.length === 0) return "bad-signature";

  const message = concatBytes(toBytes(`${timestamp}.`), toBytes(rawBody));
  if (!(await anyHmacMatches(toBytes(secret), message, candidates))) return "bad-signature";

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.abs(now - Number(timestamp)) > tolerance ? "stale-timestamp" : null;
}

export interface StripeWebhookInput extends StripeGuardOptions, StripeVerifyOptions {
  /** The exact bytes Stripe sent. Read this before any JSON middleware runs. */
  rawBody: string | Uint8Array;
  /** The `Stripe-Signature` header. */
  signature: string | null | undefined;
  /** This endpoint's `whsec_` signing secret. */
  secret: string;
}

/** Verifies, then parses, then decides whose event it is, in that order. */
export async function guardStripeWebhook(input: StripeWebhookInput): Promise<GuardResult<StripeEventLike>> {
  if (!isRawBody(input.rawBody)) return { action: "reject", status: 400, reason: "body-not-raw" };
  const failure = await verifyStripeSignature(input.rawBody, input.signature, input.secret, input);
  if (failure) return { action: "reject", status: 400, reason: failure };
  const parsed = parseJson(input.rawBody);
  if (!parsed.ok) return { action: "reject", status: 400, reason: "malformed-json" };
  const event = parsed.value as StripeEventLike;
  return toGuardResult(event, classifyStripeEvent(event, input));
}
