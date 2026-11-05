# shared-account-guard

This is a small TypeScript library and guide for running several apps on one Stripe account or one Resend account. Neither provider separates apps for you, so a webhook on a shared account can receive another app's payments and mail, and a list call can return them. This library helps each app tag what it creates and ignore what it did not create.

It has no runtime dependencies. It uses the Web Crypto API, so it runs on Node 20 or later and on edge runtimes.

Read [docs/failure-modes.md](docs/failure-modes.md) before you put two apps on one account. The library covers only part of the problem, and the guide explains the rest.

## What it does

- It tags objects with an app id, on Stripe metadata and on Resend tags.
- It verifies the webhook signature first, then decides whose event it is, and always in that order.
- It sorts each event into one of three verdicts: `ours`, `foreign` or `untagged`. Only `ours` reaches your handler.
- It keeps a foreign event's payload out of the result, so it cannot end up in your logs or database by accident.
- It filters list results, because neither provider's list calls can filter by app.
- It checks a registry file that records which app owns which domain and webhook.

## Install

The package is not on npm. Install it from the repository:

```sh
npm install github:elliothimmelfarb/shared-account-guard
```

## Tag what you create

Pick an id for each app using letters, digits, dashes and underscores only. Dots are refused, because Resend rejects them in tag values and the same id should work on both accounts.

```ts
import { stripeTag, tagCheckoutSession, tagResendEmail } from "shared-account-guard";

const session = await stripe.checkout.sessions.create(
  tagCheckoutSession("fernbank", { mode: "subscription", line_items, success_url }),
);

const customer = await stripe.customers.create({ email, metadata: stripeTag("fernbank") });

await resend.emails.send(tagResendEmail("fernbank", { from, to, subject, html }));
```

`tagCheckoutSession` tags the session and also the object the session creates, because Stripe does not copy that metadata for you. It picks the right field for the mode.

## Guard a Stripe webhook

Pass the raw body. If a JSON parser has already run, the signature cannot match and the guard rejects the request.

```ts
import { guardStripeWebhook } from "shared-account-guard";

export async function POST(request: Request) {
  const result = await guardStripeWebhook({
    rawBody: await request.text(),
    signature: request.headers.get("stripe-signature"),
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    app: "fernbank",
  });

  if (result.action === "handle") await fulfil(result.event);
  return new Response(null, { status: result.status });
}
```

The guard returns one of three actions:

| Action | Status | Meaning |
| --- | --- | --- |
| `reject` | 400 | The signature failed or the body was not raw. Nothing was parsed or classified. |
| `ignore` | 200 | The event is foreign or untagged. A 200 stops the provider retrying an event this app will never use. |
| `handle` | 200 | The event is verified and belongs to this app. |

## Deal with untagged events

Some Stripe objects never carry your tag, such as refunds and disputes, and thin events carry no metadata at all. An untagged result gives you the ids to look up, so you can prove ownership from the parent object.

```ts
if (result.action === "ignore" && result.verdict === "untagged" && result.lookup.payment_intent) {
  const intent = await stripe.paymentIntents.retrieve(result.lookup.payment_intent);
  if (classifyStripeObject(intent, { app: "fernbank" }).verdict === "ours") {
    await recordRefund(result.unclaimedEvent);
  }
}
```

Do not use `unclaimedEvent` until you have proven ownership. It may be another app's data.

## Guard a Resend webhook

Resend events are sorted by recipient for inbound mail and by tag or sending domain for delivery events.

```ts
import { guardResendWebhook } from "shared-account-guard";

export async function POST(request: Request) {
  const result = await guardResendWebhook({
    rawBody: await request.text(),
    headers: request.headers,
    secret: process.env.RESEND_WEBHOOK_SECRET!,
    app: "fernbank",
    receivingDomains: ["in.fernbank.example"],
    sendingDomains: ["fernbank.example"],
  });

  if (result.action === "handle") await process(result.event, result.deliveryId);
  return new Response(null, { status: result.status });
}
```

Domains match exactly, so list each subdomain. `deliveryId` is the `svix-id` header, which you can use to skip duplicates.

## Filter list results

Every job that lists from a shared account needs a filter, including catch-up jobs and reports.

```ts
import { onlyOurReceivedEmails, onlyOurStripeObjects } from "shared-account-guard";

const { data: sessions } = await stripe.checkout.sessions.list({ limit: 100 });
const ours = onlyOurStripeObjects(sessions, { app: "fernbank" });

const { data: inbound } = await resend.emails.receiving.list();
const mail = onlyOurReceivedEmails(inbound?.data ?? [], resendOptions);
```

## Keep a registry

[examples/registry.example.json](examples/registry.example.json) shows the format, with three fictional apps. It holds no secrets. `checkRegistry` returns a sentence for each problem it finds, such as two apps receiving on one domain or the same webhook registered twice. `stripeOptionsFor` and `resendOptionsFor` build guard options from it, so each app's filter comes from one file.

## What it does not do

- It cannot stop a key from reading other apps' data. Keys on these accounts are not scoped to an app.
- It does not protect you from another app on the account behaving badly, because any app can write any tag.
- It does not remove duplicates. Use `eventId` or `deliveryId` for that.
- It does not separate Resend's suppression list, which covers the whole team.

If two apps need a real wall between them, give them separate accounts.

## Development

```sh
npm ci
npm test
npm run typecheck
```

The tests sign payloads with the real `stripe` and `svix` packages, which are dev dependencies only, so they also confirm that the verifiers here agree with the official libraries.

## License

MIT. See [LICENSE](LICENSE).
