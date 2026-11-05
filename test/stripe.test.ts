import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  classifyStripeEvent,
  classifyStripeObject,
  guardStripeWebhook,
  onlyOurStripeObjects,
  tagCheckoutSession,
  verifyStripeSignature,
} from "../src/index.js";
import { NOW, STRIPE_SECRET, stripeEvent, stripeHeader } from "./helpers.js";

const app = "fernbank";
const guard = (rawBody: string | Uint8Array, signature: string | null, extra = {}) =>
  guardStripeWebhook({ rawBody, signature, secret: STRIPE_SECRET, app, nowSeconds: NOW, ...extra });
const signed = (body: string) => guard(body, stripeHeader(body));

describe("guardStripeWebhook: whose event is it", () => {
  it("hands over an event tagged for this app", async () => {
    const r = await signed(stripeEvent({ metadata: { app } }));
    expect(r.action).toBe("handle");
  });

  it("ignores another app's event with a 200 and keeps its data out of the result", async () => {
    const body = stripeEvent({ metadata: { app: "tidepool" }, customer_email: "buyer@tidepool.example" });
    const r = await signed(body);
    expect(r).toMatchObject({ action: "ignore", status: 200, verdict: "foreign" });
    expect(JSON.stringify(r)).not.toContain("buyer@tidepool.example");
  });

  it.each([
    ["no metadata field", {}],
    ["null metadata", { metadata: null }],
    ["empty metadata", { metadata: {} }],
    ["an empty tag", { metadata: { app: "" } }],
    ["a tag that is not a string", { metadata: { app: 7 } }],
  ])("does not handle an event with %s", async (_name, object) => {
    const r = await signed(stripeEvent(object));
    expect(r).toMatchObject({ action: "ignore", status: 200, verdict: "untagged" });
  });

  it("does not match a tag that differs only by case or prefix", async () => {
    expect(classifyStripeObject({ metadata: { app: "Fernbank" } }, { app }).verdict).toBe("foreign");
    expect(classifyStripeObject({ metadata: { app: "fernbank-old" } }, { app }).verdict).toBe("foreign");
  });
});

describe("guardStripeWebhook: the signature comes first", () => {
  const foreign = stripeEvent({ metadata: { app: "tidepool" } });
  const ours = stripeEvent({ metadata: { app } });

  it("rejects a forged event for another app instead of ignoring it with a 200", async () => {
    const r = await guard(foreign, stripeHeader(foreign, "whsec_wrong"));
    expect(r).toMatchObject({ action: "reject", status: 400, reason: "bad-signature" });
  });

  it("rejects a forged event carrying this app's tag", async () => {
    const r = await guard(ours, stripeHeader(ours, "whsec_wrong"));
    expect(r.action).toBe("reject");
  });

  it("checks the signature before it parses the body", async () => {
    const r = await guard("not json", stripeHeader("{}", "whsec_wrong"));
    expect(r).toMatchObject({ action: "reject", reason: "bad-signature" });
  });

  it("rejects a body changed after signing", async () => {
    const header = stripeHeader(foreign);
    const r = await guard(ours, header);
    expect(r).toMatchObject({ action: "reject", reason: "bad-signature" });
  });

  it("rejects a missing header", async () => {
    expect(await guard(ours, null)).toMatchObject({ action: "reject", reason: "missing-signature" });
  });

  it("rejects a replay outside the tolerance, in either direction", async () => {
    const old = await guard(ours, stripeHeader(ours, STRIPE_SECRET, NOW - 301));
    const future = await guard(ours, stripeHeader(ours, STRIPE_SECRET, NOW + 301));
    expect(old).toMatchObject({ action: "reject", reason: "stale-timestamp" });
    expect(future).toMatchObject({ action: "reject", reason: "stale-timestamp" });
  });

  it("rejects a parsed body, which can never match the signature", async () => {
    const parsed = JSON.parse(ours) as unknown as string;
    expect(await guard(parsed, stripeHeader(ours))).toMatchObject({ action: "reject", reason: "body-not-raw" });
  });

  it("ignores v0 signatures so a downgrade cannot pass", async () => {
    const v1 = stripeHeader(ours).match(/v1=([0-9a-f]+)/)?.[1];
    expect(await guard(ours, `t=${NOW},v0=${v1}`)).toMatchObject({ action: "reject", reason: "bad-signature" });
  });

  it("accepts during a secret rotation, when one of two v1 signatures matches", async () => {
    const good = stripeHeader(ours).match(/v1=([0-9a-f]+)/)?.[1];
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${good}`;
    expect((await guard(ours, header)).action).toBe("handle");
  });

  it("verifies a Buffer the same as a string", async () => {
    const r = await guard(Buffer.from(ours), stripeHeader(ours));
    expect(r.action).toBe("handle");
  });

  it("verifies a body with non-ASCII text", async () => {
    const body = stripeEvent({ metadata: { app }, description: "café é" });
    expect((await signed(body)).action).toBe("handle");
  });

  it("rejects a correctly signed body that is not JSON", async () => {
    const r = await guard("not json", stripeHeader("not json"));
    expect(r).toMatchObject({ action: "reject", reason: "malformed-json" });
  });

  it("refuses to run with an unset secret, because anyone could sign with an empty key", async () => {
    await expect(guard(ours, stripeHeader(ours), { secret: "" })).rejects.toThrow(/secret/);
  });

  it("refuses a tolerance of 0, which turns off the replay check", async () => {
    await expect(guard(ours, stripeHeader(ours), { toleranceSeconds: 0 })).rejects.toThrow(/tolerance/);
  });
});

describe("classifyStripeObject: where the tag lives", () => {
  it("reads a subscription invoice's tag from parent.subscription_details", () => {
    const invoice = { metadata: {}, parent: { subscription_details: { metadata: { app } } } };
    expect(classifyStripeObject(invoice, { app }).verdict).toBe("ours");
  });

  it("reads the older top-level subscription_details", () => {
    const invoice = { metadata: null, subscription_details: { metadata: { app: "tidepool" } } };
    expect(classifyStripeObject(invoice, { app }).verdict).toBe("foreign");
  });

  it("reads subscription line items", () => {
    const invoice = { metadata: {}, lines: { data: [{ metadata: { app } }] } };
    expect(classifyStripeObject(invoice, { app }).verdict).toBe("ours");
  });

  it("treats a conflict as foreign", () => {
    const invoice = { metadata: { app }, parent: { subscription_details: { metadata: { app: "tidepool" } } } };
    expect(classifyStripeObject(invoice, { app }).verdict).toBe("foreign");
  });

  it("uses a custom tag key", () => {
    expect(classifyStripeObject({ metadata: { product: app } }, { app, tagKey: "product" }).verdict).toBe("ours");
    expect(classifyStripeObject({ metadata: { app } }, { app, tagKey: "product" }).verdict).toBe("untagged");
  });
});

describe("untagged events keep a path back to their owner", () => {
  it("gives a refund's parent ids, because refunds do not inherit metadata", async () => {
    const body = stripeEvent(
      { object: "refund", metadata: {}, payment_intent: "pi_1", charge: { id: "ch_1" } },
      "refund.created",
    );
    const r = await signed(body);
    expect(r).toMatchObject({
      action: "ignore",
      verdict: "untagged",
      lookup: { payment_intent: "pi_1", charge: "ch_1" },
    });
  });

  it("gives a thin event its related object, since it carries no metadata", () => {
    const thin = {
      id: "evt_thin",
      object: "v2.core.event",
      type: "v1.billing.meter.error_report_triggered",
      related_object: { id: "mtr_1", type: "billing.meter", url: "/v1/billing/meters/mtr_1" },
    };
    expect(classifyStripeEvent(thin, { app })).toMatchObject({
      verdict: "untagged",
      lookup: { related_object: "mtr_1" },
    });
  });
});

describe("onlyOurStripeObjects", () => {
  it("drops foreign and untagged rows from a list result", () => {
    const rows = [
      { id: "a", metadata: { app } },
      { id: "b", metadata: { app: "tidepool" } },
      { id: "c", metadata: {} },
      { id: "d" },
    ];
    expect(onlyOurStripeObjects(rows, { app }).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("tagCheckoutSession", () => {
  it("tags the session and the PaymentIntent in payment mode, and leaves subscription_data out", () => {
    const params = tagCheckoutSession(app, { mode: "payment", metadata: { order: "9" } });
    expect(params.metadata).toEqual({ order: "9", app });
    expect(params.payment_intent_data?.metadata).toEqual({ app });
    expect(params).not.toHaveProperty("subscription_data");
  });

  it("tags the session and the Subscription in subscription mode, and leaves payment_intent_data out", () => {
    const params = tagCheckoutSession(app, { mode: "subscription" });
    expect(params.subscription_data?.metadata).toEqual({ app });
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("tags the SetupIntent in setup mode", () => {
    const params = tagCheckoutSession(app, { mode: "setup" });
    expect(params.setup_intent_data?.metadata).toEqual({ app });
  });

  it("keeps the caller's nested fields", () => {
    const params = tagCheckoutSession(app, {
      mode: "payment",
      payment_intent_data: { description: "x", metadata: { order: "9" } },
    });
    expect(params.payment_intent_data).toEqual({ description: "x", metadata: { order: "9", app } });
  });

  it("refuses to overwrite another app's tag", () => {
    expect(() => tagCheckoutSession(app, { mode: "payment", metadata: { app: "tidepool" } })).toThrow(/tidepool/);
  });

  it("refuses a missing mode, since the right nested field depends on it", () => {
    expect(() => tagCheckoutSession(app, {})).toThrow(/mode/);
  });

  it("refuses an id Resend would reject, so the same id works on both accounts", () => {
    expect(() => tagCheckoutSession("fern.bank", { mode: "payment" })).toThrow(/app id/);
  });
});

describe("S2: an unclaimed payload never reaches a log", () => {
  const body = stripeEvent(
    { object: "refund", metadata: {}, payment_intent: "pi_1", receipt_email: "customer@tidepool.example" },
    "refund.created",
  );

  it("keeps it out of JSON, spreads and inspection, and hands it over on claim()", async () => {
    const r = await signed(body);
    expect(JSON.stringify(r)).not.toContain("customer@tidepool.example");
    expect(JSON.stringify({ ...r })).not.toContain("customer@tidepool.example");
    expect(inspect(r, { depth: null, showHidden: false })).not.toContain("customer@tidepool.example");
    expect(structuredClone(r)).not.toHaveProperty("claim");
    if (r.action !== "ignore" || r.verdict !== "untagged") throw new Error("expected untagged");
    expect(r.claim().data?.object).toMatchObject({ receipt_email: "customer@tidepool.example" });
  });
});

describe("S6: hardening", () => {
  const ours = stripeEvent({ metadata: { app } });

  it.each(["  ", "whsec_ ", "whsec_\n", "whsec_", " whsec_ \t"])("refuses the blank secret %j", async (secret) => {
    await expect(guard(ours, stripeHeader(ours, secret.trim() || "x"), { secret })).rejects.toThrow(/secret/);
  });

  it.each([NaN, Infinity, -Infinity, -1])("refuses a tolerance of %s, which would turn off the replay check", async (t) => {
    await expect(guard(ours, stripeHeader(ours), { toleranceSeconds: t })).rejects.toThrow(/tolerance/);
  });

  it("returns a result that cannot be misread as true on failure", async () => {
    expect(await verifyStripeSignature(ours, stripeHeader(ours), STRIPE_SECRET, { nowSeconds: NOW })).toEqual({ ok: true });
    expect(await verifyStripeSignature(ours, "t=1,v1=" + "0".repeat(64), STRIPE_SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("strips control characters from a foreign tag before it reaches a log", () => {
    const c = classifyStripeObject({ metadata: { app: "evil\n[INFO] forged\u2028line\u0007" } }, { app });
    expect(c).toMatchObject({ verdict: "foreign", reason: "tagged for evil[INFO] forgedline" });
  });

  it("caps a foreign tag in the reason", () => {
    expect(classifyStripeObject({ metadata: { app: "x".repeat(600) } }, { app }).reason.length).toBeLessThan(100);
  });
});
