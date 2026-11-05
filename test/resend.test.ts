import { describe, expect, it } from "vitest";
import {
  classifyReceivedEmail,
  classifyResendEvent,
  classifySentEmail,
  guardResendWebhook,
  onlyOurReceivedEmails,
  onlyOurSentEmails,
  resendTags,
  tagResendEmail,
  verifyResendSignature,
  type ResendGuardOptions,
} from "../src/index.js";
import { NOW, RESEND_SECRET, svixHeaders } from "./helpers.js";

const opts: ResendGuardOptions = {
  app: "fernbank",
  receivingDomains: ["in.fernbank.example"],
  sendingDomains: ["fernbank.example", "mail.studio.example"],
  sharedSendingDomains: ["mail.studio.example"],
};
const guard = (rawBody: string | Uint8Array, headers: Record<string, string> | Headers, extra = {}) =>
  guardResendWebhook({ rawBody, headers, secret: RESEND_SECRET, nowSeconds: NOW, ...opts, ...extra });
const signed = (event: unknown) => {
  const body = JSON.stringify(event);
  return guard(body, svixHeaders(body));
};
const received = (data: Record<string, unknown>) => ({ type: "email.received", data });
const bounced = (data: Record<string, unknown>) => ({ type: "email.bounced", data });

describe("guardResendWebhook: inbound mail", () => {
  it("hands over mail addressed to this app's receiving domain", async () => {
    const r = await signed(received({ to: ["Help <help@in.fernbank.example>"], cc: [], bcc: [] }));
    expect(r.action).toBe("handle");
  });

  it("ignores mail for another app and keeps its subject out of the result", async () => {
    const r = await signed(received({ to: ["help@tidepool.example"], subject: "private thing" }));
    expect(r).toMatchObject({ action: "ignore", status: 200, verdict: "foreign" });
    expect(JSON.stringify(r)).not.toContain("private thing");
  });

  it.each([["cc"], ["bcc"], ["received_for"]])("finds this app in %s", async (field) => {
    const r = await signed(received({ to: ["a@tidepool.example"], [field]: ["b@in.fernbank.example"] }));
    expect(r.action).toBe("handle");
  });

  it("treats mail with no recipients as untagged", async () => {
    const r = await signed(received({ to: null, cc: null, bcc: null }));
    expect(r).toMatchObject({ action: "ignore", verdict: "untagged" });
  });

  it.each([
    ["a lookalike ending", "x@notin.fernbank.example"],
    ["our domain as a subdomain of theirs", "x@in.fernbank.example.tidepool.example"],
    ["a sibling subdomain", "x@other.fernbank.example"],
    ["a parent domain", "x@fernbank.example"],
    ["our address only in the display name", '"x@in.fernbank.example" <y@tidepool.example>'],
  ])("does not claim %s", (_name, to) => {
    expect(classifyReceivedEmail({ to: [to] }, opts).verdict).toBe("foreign");
  });

  it("ignores case in addresses", () => {
    expect(classifyReceivedEmail({ to: ["Help@IN.Fernbank.Example"] }, opts).verdict).toBe("ours");
  });
});

describe("guardResendWebhook: delivery events", () => {
  it("handles a bounce from this app's own domain", async () => {
    const r = await signed(bounced({ from: "Fernbank <hello@fernbank.example>", to: ["c@d.example"], tags: {} }));
    expect(r.action).toBe("handle");
  });

  it("ignores a bounce from another app's domain, so one app never suppresses another's customer", async () => {
    const r = await signed(bounced({ from: "Tide <hi@tidepool.example>", to: ["c@d.example"] }));
    expect(r).toMatchObject({ action: "ignore", verdict: "foreign" });
  });

  it("uses the tag on a shared sending domain", async () => {
    const data = { from: "hi@mail.studio.example", to: ["c@d.example"] };
    expect((await signed(bounced({ ...data, tags: { app: "fernbank" } }))).action).toBe("handle");
    expect(await signed(bounced({ ...data, tags: { app: "tidepool" } }))).toMatchObject({ verdict: "foreign" });
  });

  it("does not claim an untagged event on a shared sending domain", async () => {
    const r = await signed(bounced({ from: "hi@mail.studio.example", to: ["c@d.example"], tags: {} }));
    expect(r).toMatchObject({ action: "ignore", verdict: "untagged" });
  });

  it("lets a foreign tag win over our own domain", async () => {
    const r = await signed(bounced({ from: "hi@fernbank.example", tags: { app: "tidepool" } }));
    expect(r).toMatchObject({ verdict: "foreign" });
  });

  it("treats a delivery event with no from address as untagged", async () => {
    expect(await signed(bounced({ to: ["c@d.example"] }))).toMatchObject({ verdict: "untagged" });
  });

  it("does not claim account-level events", () => {
    for (const type of ["domain.updated", "contact.created", "suppression.added", "inbox.email.received"]) {
      expect(classifyResendEvent({ type, data: { name: "fernbank.example" } }, opts).verdict).toBe("untagged");
    }
  });
});

describe("guardResendWebhook: the signature comes first", () => {
  const foreign = JSON.stringify(received({ to: ["a@tidepool.example"] }));
  const ours = JSON.stringify(received({ to: ["a@in.fernbank.example"] }));
  const otherSecret = ["whsec", btoa("some-other-signing-value-98765")].join("_");

  it("rejects a forged event for another app instead of ignoring it with a 200", async () => {
    const r = await guard(foreign, svixHeaders(foreign, { secret: otherSecret }));
    expect(r).toMatchObject({ action: "reject", status: 400, reason: "bad-signature" });
  });

  it("checks the signature before it parses the body", async () => {
    const r = await guard("not json", svixHeaders("{}", { secret: otherSecret }));
    expect(r).toMatchObject({ action: "reject", reason: "bad-signature" });
  });

  it("rejects a body changed after signing", async () => {
    expect(await guard(ours, svixHeaders(foreign))).toMatchObject({ action: "reject", reason: "bad-signature" });
  });

  it("rejects when a header is missing", async () => {
    const { "svix-id": _id, ...rest } = svixHeaders(ours);
    expect(await guard(ours, rest)).toMatchObject({ action: "reject", reason: "missing-signature" });
  });

  it("rejects a replay outside the tolerance, in either direction", async () => {
    const old = await guard(ours, svixHeaders(ours, { timestamp: NOW - 301 }));
    const future = await guard(ours, svixHeaders(ours, { timestamp: NOW + 301 }));
    expect(old).toMatchObject({ reason: "stale-timestamp" });
    expect(future).toMatchObject({ reason: "stale-timestamp" });
  });

  it("rejects a parsed body", async () => {
    const parsed = JSON.parse(ours) as unknown as string;
    expect(await guard(parsed, svixHeaders(ours))).toMatchObject({ reason: "body-not-raw" });
  });

  it("accepts during a rotation, when one of several signatures matches", async () => {
    const headers = svixHeaders(ours);
    headers["svix-signature"] = `v1,${btoa("x".repeat(32))} ${headers["svix-signature"]}`;
    expect((await guard(ours, headers)).action).toBe("handle");
  });

  it("reads a Headers object and returns the delivery id for de-duplication", async () => {
    const r = await guard(ours, new Headers(svixHeaders(ours)));
    expect(r).toMatchObject({ action: "handle", deliveryId: "msg_test_1" });
  });

  it("refuses to run with an unset secret", async () => {
    await expect(guard(ours, svixHeaders(ours), { secret: "whsec_" })).rejects.toThrow(/secret/);
  });
});

describe("list helpers", () => {
  it("drops other apps' mail from the received list, which has no filter of its own", () => {
    const rows = [
      { id: "a", to: ["x@in.fernbank.example"] },
      { id: "b", to: ["x@tidepool.example"] },
      { id: "c", to: [] },
    ];
    expect(onlyOurReceivedEmails(rows, opts).map((r) => r.id)).toEqual(["a"]);
  });

  it("drops other apps' mail and unprovable shared-domain mail from the sent list", () => {
    const rows = [
      { id: "a", from: "Fernbank <hi@fernbank.example>" },
      { id: "b", from: "hi@tidepool.example" },
      { id: "c", from: "hi@mail.studio.example" },
    ];
    expect(onlyOurSentEmails(rows, opts).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("tag shapes", () => {
  it("reads the list shape the retrieve endpoint returns, which is how shared-domain mail gets proven", () => {
    const email = { from: "hi@mail.studio.example", tags: [{ name: "app", value: "fernbank" }] };
    expect(classifySentEmail(email, opts).verdict).toBe("ours");
  });
});

describe("tagging outbound mail", () => {
  it("adds the tag and keeps the caller's tags", () => {
    const params = tagResendEmail("fernbank", { to: "a@b.example", tags: [{ name: "kind", value: "receipt" }] });
    expect(params.tags).toEqual([
      { name: "kind", value: "receipt" },
      { name: "app", value: "fernbank" },
    ]);
  });

  it("refuses to overwrite another app's tag", () => {
    expect(() => tagResendEmail("fernbank", { tags: [{ name: "app", value: "tidepool" }] })).toThrow(/tidepool/);
  });

  it("refuses an id with characters Resend rejects in tags", () => {
    expect(() => resendTags("fern.bank")).toThrow(/app id/);
  });
});

describe("S2: an unclaimed payload never reaches a log", () => {
  it("keeps a shared-domain recipient out of JSON and still carries the delivery id", async () => {
    const r = await signed(bounced({ from: "hi@mail.studio.example", to: ["private@customer.example"] }));
    expect(r).toMatchObject({ verdict: "untagged", deliveryId: "msg_test_1" });
    expect(JSON.stringify(r)).not.toContain("private@customer.example");
    if (r.action !== "ignore" || r.verdict !== "untagged") throw new Error("expected untagged");
    expect(r.claim().data).toMatchObject({ to: ["private@customer.example"] });
  });
});

describe("S3: only the envelope decides, and only clean addresses count", () => {
  it("lets received_for overrule a To header the sender wrote", () => {
    const email = { to: ["z@in.fernbank.example"], received_for: ["help@in.tidepool.example"] };
    expect(classifyReceivedEmail(email, opts).verdict).toBe("foreign");
  });

  it("does not read headers when received_for is present", () => {
    const email = { to: ["help@in.tidepool.example"], cc: ["z@in.fernbank.example"], received_for: ["a@tidepool.example"] };
    expect(classifyReceivedEmail(email, opts).verdict).toBe("foreign");
  });

  it("still uses headers when received_for is empty", () => {
    expect(classifyReceivedEmail({ to: ["z@in.fernbank.example"], received_for: [] }, opts).verdict).toBe("ours");
  });

  it.each([
    ["two brackets", "Evil <z@in.fernbank.example> <x@tidepool.example>"],
    ["a second address in the display name", "x@tidepool.example <z@in.fernbank.example>"],
    ["a comma list", "x@tidepool.example, y@in.fernbank.example"],
    ["a comma list with brackets", 'x@tidepool.example, "b" <y@in.fernbank.example>'],
    ["a double at sign", "x@tidepool.example@in.fernbank.example"],
    ["junk after a bracket", "<x@tidepool.example>y@in.fernbank.example"],
    ["a space in the address", "x y@in.fernbank.example"],
  ])("does not claim %s", (_name, to) => {
    expect(classifyReceivedEmail({ to: [to] }, opts).verdict).toBe("foreign");
    expect(classifyReceivedEmail({ received_for: [to] }, opts).verdict).toBe("foreign");
  });

  it("keeps accepting a quoted display name with a comma", () => {
    expect(classifyReceivedEmail({ to: ['"Doe, Jane" <j@in.fernbank.example>'] }, opts).verdict).toBe("ours");
  });
});

describe("S6: hardening", () => {
  const ours = JSON.stringify(received({ to: ["a@in.fernbank.example"] }));

  it.each([
    ["ours first", [{ name: "app", value: "fernbank" }, { name: "app", value: "tidepool" }]],
    ["ours last", [{ name: "app", value: "tidepool" }, { name: "app", value: "fernbank" }]],
  ])("treats conflicting tags as foreign, %s", (_name, tags) => {
    expect(classifySentEmail({ tags }, opts).verdict).toBe("foreign");
  });

  it("strips control characters from a foreign tag before it reaches a log", () => {
    const c = classifySentEmail({ tags: { app: "evil\r\n[INFO] forged" } }, opts);
    expect(c.reason).toBe("tagged for evil[INFO] forged");
  });

  it("returns a result that cannot be misread as true on failure", async () => {
    const good = await verifyResendSignature(ours, svixHeaders(ours), RESEND_SECRET, { nowSeconds: NOW });
    expect(good).toEqual({ ok: true });
    const bad = await verifyResendSignature(ours, svixHeaders("{}"), RESEND_SECRET, { nowSeconds: NOW });
    expect(bad).toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([NaN, Infinity])("refuses a tolerance of %s", async (toleranceSeconds) => {
    await expect(guard(ours, svixHeaders(ours), { toleranceSeconds })).rejects.toThrow(/tolerance/);
  });
});
