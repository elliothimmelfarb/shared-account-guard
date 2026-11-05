# Failure modes on a shared Stripe or Resend account

This guide covers what goes wrong when several apps share one account. The examples use three fictional apps: fernbank, tidepool and lanternworks. The last section lists what was checked against current documentation and what was not.

## The usual way this fails

Fernbank and tidepool share a Resend account. Fernbank has a nightly job that lists received mail, so it can catch anything its webhook missed. The job was written when fernbank was the only app. The day tidepool starts receiving mail, fernbank files tidepool's customer messages in its own support queue and notifies its team about each one.

Nothing crashed, and the webhook handler was already filtered correctly. The leak was in a code path nobody thought of as reading from a shared space. That is the usual pattern: the main handler gets a filter, and the refund handler, the bounce handler and the catch-up job do not.

## 1. Every webhook hears about every app

Stripe and Resend let you choose which event types an endpoint receives. Neither lets you choose which app's events it receives. On Stripe, an event destination is scoped by event type and by source (your account, or your connected accounts). On Resend, a webhook has only a URL and a list of event types. So every endpoint subscribed to `checkout.session.completed` receives every completed checkout on the account.

What to do:

- Give each app its own endpoint and signing secret, subscribed only to the events it handles.
- Check the signature first, then check the tag, in every handler. A check placed after the signature in one handler protects only that handler.
- Reply 200 to events that are not yours. Stripe treats anything other than a 2xx as a failed delivery and retries for up to three days in live mode. Resend makes up to 8 attempts over a little more than a day.
- Reply 400 to a bad signature. If you filter before you verify, a forged request gets the same 200 as a real foreign event, and your filter is reading data nobody has authenticated.

Stripe allows at most 16 event destinations per account, including sandbox accounts. That cap applies to the whole shared account, so count it before adding apps.

## 2. The tag does not follow the money

Stripe says metadata does not copy to related objects, apart from a short list of exceptions. Tagging the Checkout Session is not enough, and this is where most missed events come from.

| Event | Object in the event | Does your tag arrive? |
| --- | --- | --- |
| `checkout.session.*` | Checkout Session | Yes, from `metadata`. |
| `payment_intent.*`, one-time payment | PaymentIntent | Only if you set `payment_intent_data.metadata`. |
| `charge.*`, one-time payment | Charge | Yes if the PaymentIntent had it when the charge was created. It is a one-time copy, so later updates do not reach it. |
| `customer.subscription.*` | Subscription | Only if you set `subscription_data.metadata`. |
| `invoice.*`, subscription | Invoice | Yes, but in `parent.subscription_details.metadata` and not in `metadata`. A check of `invoice.metadata` alone misses it. |
| `payment_intent.*` and `charge.*`, subscription renewal | PaymentIntent, Charge | No. Stripe lists no copy from a Subscription to a PaymentIntent. Use `invoice.paid` for renewals. |
| `refund.*` | Refund | No. A Refund has its own empty metadata. Use `payment_intent` or `charge` to find the owner. |
| `charge.dispute.*` | Dispute | No, Stripe lists no such copy. Use `payment_intent` or `charge` to find the owner. |
| `customer.*` | Customer | Only if you tag the Customer when you create it. |
| Payouts and balance events | Payout, Balance | Never. These belong to the account and not to an app. |

The library reads all the invoice locations and returns `lookup` ids for refunds and disputes. Payment Links copy their metadata to the session, but you must still set `payment_intent_data` or `subscription_data` on the link.

Thin events are a separate case. Stripe recommends them for new integrations, and they carry only an id, a type and a related object, so there is no metadata to read. The guard returns `untagged` for all of them, and you must fetch the related object to find the owner.

A missing tag is treated as "not proven ours", not as "not mine". The difference matters for your own old data: anything created before you started tagging comes through as untagged and is ignored until you backfill it.

Do not check tags in browser code. Stripe redacts metadata from responses to publishable key requests.

## 3. List calls return everything

Webhooks at least arrive one at a time and invite a filter. List calls are worse, because they feel like reading your own data.

- `GET /v1/events` filters by type, date and delivery status, not by metadata. It goes back 30 days.
- Resend's list of received mail takes only `limit`, `after` and `before`, and it covers your whole team.
- Resend's list of sent mail takes the same three parameters and its documented response has no `tags` field. On a shared sending domain you cannot tell whose mail is whose without retrieving each email. `onlyOurSentEmails` drops those rows, and `classifySentEmail` works on the retrieved email, which does include tags.
- Resend's list of received mail does not document a `received_for` field, though the webhook does. Forwarded mail can pass the webhook guard and still look foreign on the list path.

Stripe's Search API can filter by metadata, using a query such as `metadata["app"]:"fernbank"`. Use it with care:

- It covers only charges, customers, invoices, PaymentIntents, prices, products and subscriptions. It does not cover Checkout Sessions or refunds.
- New data usually takes under a minute to appear, so it is wrong for read-after-write flows.
- Metadata is matched as a token, and token matches ignore case, so filter the results as well.
- Subscription invoices keep the tag under `parent.subscription_details`, so an invoice search on `metadata` can miss them. This is an inference from the metadata and search pages, not something Stripe states.
- It is not available to businesses in India.

Anything that reports across the account, such as revenue totals, needs the same filter. An unfiltered report does not look like a leak, but it is one.

## 4. Restricted keys limit less than people think

A restricted key limits which kinds of resource it can touch, not which objects. Each resource gets None, Read or Write. A fernbank key with Read on Charges can read tidepool's charges too, since nothing on the key's permissions page narrows it by metadata or by app. Access policies limit where a key can be used from, by IP address, network or country, and they do not limit what it can see.

Resend has two permissions. `sending_access` can only send email, and it can be limited to one domain. `full_access` can create, delete, get and update any resource. So an app that reads received mail needs `full_access`, because `sending_access` allows nothing else. That key can also read every other app's mail and delete their domains.

What to do:

- Still give each app its own named key with the fewest permissions. It limits the damage from a leak and shows up in the request logs.
- Do not describe per-app keys as isolation. Everything in this guide is cooperation between apps that behave well, and it is not a security boundary.
- Keep apps that need a real boundary on separate accounts. This includes anything run with a partner who should not see your other customers. Stripe Organizations can group accounts for that, and a separate account is the only boundary we found in either provider's documentation.

## 5. Delivery events cross apps too

Resend sends `email.bounced`, `email.complained` and the rest to every webhook subscribed to them, for mail any app sent. A bounce handler that disables a user, without checking whose mail bounced, lets one app's mailing damage another app's customer records.

The guard decides these events by the tag if there is one, then by sending domain. On a domain several apps send from, the domain proves nothing, so list it in `sharedSendingDomains`, tag every message, and untagged events come back as `untagged`.

The `from` field on sent events can include a display name, such as `Fernbank <hello@fernbank.example>`. Received events carry a bare address. The guard handles both, and it never reads an address from the display name.

## 6. Two apps cannot share a receiving domain

Resend receives mail for any address at a domain. The recipient's domain is the only signal the guard has for inbound mail, so two apps on one domain cannot be told apart. Give each app its own receiving domain or subdomain. `checkRegistry` reports this.

Domains match exactly. `in.fernbank.example` does not cover `other.fernbank.example`, and a lookalike such as `notin.fernbank.example` does not match.

The guard checks `to`, `cc`, `bcc` and `received_for`. Treat these as hints about routing and not as proof. The `to` and `cc` values appear to come from the message headers, which the sender writes. So a sender may be able to reach tidepool's inbox with a `To:` line naming fernbank, in which case fernbank's handler would claim it. This is an inference, and it has not been tested. Treat inbound mail as untrusted input in every app.

## 7. Some things are shared and cannot be split

- Resend's suppression list covers the whole team. An address that hard bounces or complains on one app is skipped for every app, on every domain. The guard treats `suppression.*` as untagged, so no app acts on them alone.
- Domain, contact, topic and inbox events on Resend belong to the account. The guard treats them as untagged too. If you use Resend Inboxes, you need to add your own ownership check using `inbox_id`.
- A Stripe Customer tagged for one app can be reused by another by mistake. Do not look customers up by email across the account. Search by the tag as well.
- Any app with a write key can set any tag. The tag marks whose object it is, and it cannot prove that the right app wrote it.

## 8. Things that fail quietly

- **Parsed bodies.** Signatures cover the exact bytes. Read the raw body before any JSON middleware. The guard rejects a parsed object.
- **An empty secret.** An unset environment variable can turn into an empty signing key, and anyone can sign with that. The guard throws instead of running.
- **Tolerance of 0.** Stripe says this turns off the recency check. The guard refuses it.
- **Duplicates.** Stripe can deliver one event twice, and sometimes sends two separate events for one change. Track event ids, and for the second case compare the `data.object` id and the event type. Stripe also does not guarantee order. Resend retries reuse the same `svix-id`.
- **Dots in app ids.** Stripe accepts them in metadata, but Resend rejects them in tag values, so a dotted id works on one account and fails on the other.
- **A new event subscription.** Adding an event type to an existing endpoint can bring in events your handler never saw from other apps. Run the filter on everything, not only on the events you expect.

## Adding an app

1. Add it to the registry and run `checkRegistry`.
2. Decide whether it belongs on the shared account at all. See section 4.
3. Tag everything it creates. Use `tagCheckoutSession` and `tagResendEmail`.
4. Give it its own webhook endpoints, secrets and named keys.
5. Give it its own receiving domain.
6. Search its code for every Stripe and Resend list call, and filter each one.
7. Write one test per provider showing that another app's event is ignored.

## What was checked, and how

Checked on 2026-11-05 against the providers' documentation, with `stripe` 23.1.0, `svix` 2.9.1 and `standardwebhooks` 1.1.1. Nothing here was tested against a live Stripe or Resend account.

**Stated in the documentation**

| Claim | Source |
| --- | --- |
| Signature format, `v1` only, raw body, 5 minute library default, tolerance of 0 disables the check | [Stripe webhooks](https://docs.stripe.com/webhooks) |
| Retries for up to 3 days in live mode, no ordering guarantee, duplicates | [Stripe webhooks](https://docs.stripe.com/webhooks) |
| Limit of 16 event destinations, thin event contents | [How events work](https://docs.stripe.com/events/how-events-work) |
| Metadata does not copy apart from listed exceptions, limits, redaction for publishable keys | [Metadata](https://docs.stripe.com/metadata) |
| `payment_intent_data` is for payment mode, `subscription_data` for subscription mode | [Create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create) |
| Refund and Dispute have their own `metadata` plus `payment_intent` and `charge` | [Refund](https://docs.stripe.com/api/refunds/object), [Dispute](https://docs.stripe.com/api/disputes/object) |
| Events list parameters, 30 days | [List events](https://docs.stripe.com/api/events/list) |
| Search resources, freshness, token matching, regional limit | [Search](https://docs.stripe.com/search) |
| Restricted keys use None, Read or Write per resource, and access policies | [Restricted keys](https://docs.stripe.com/keys/restricted-api-keys), [API keys](https://docs.stripe.com/keys) |
| `svix-*` headers, raw body requirement | [Resend verify](https://resend.com/docs/webhooks/verify-webhooks-requests) |
| Signed content is `id.timestamp.body`, secret decoding, signature list format | [Svix manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual) |
| Retry schedule of 8 attempts | [Resend retries](https://resend.com/docs/webhooks/retries-and-replays) |
| Webhook parameters are `endpoint` and `events` | [Create webhook](https://resend.com/docs/api-reference/webhooks/create-webhook) |
| Event types, retries reuse `svix-id` (stated for inbox events) | [Event types](https://resend.com/docs/webhooks/event-types) |
| Received payload fields including `received_for`, no body in the webhook | [email.received](https://resend.com/docs/webhooks/emails/received) |
| `tags` is a map and `from` may have a display name on sent events | [email.delivered](https://resend.com/docs/webhooks/emails/delivered) |
| `tags` is a list on the retrieve endpoint | [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email) |
| List endpoints take `limit`, `after` and `before`, and cover the team | [Received](https://resend.com/docs/api-reference/emails/list-received-emails), [Sent](https://resend.com/docs/api-reference/emails/list-emails) |
| `sending_access` can only send and can be limited to a domain | [Create API key](https://resend.com/docs/api-reference/api-keys/create-api-key) |
| Tag names and values allow ASCII letters, digits, `_` and `-` | [Send email](https://resend.com/docs/api-reference/emails/send-email) |
| Receiving covers any address at a domain | [Receiving](https://resend.com/docs/dashboard/receiving/introduction) |
| Suppressions apply to the whole team, across all domains | [Suppressions](https://resend.com/docs/dashboard/emails/email-suppressions) |

**Checked in code, not in prose**

- The Svix tolerance of 5 minutes in both directions comes from the `standardwebhooks` source, because Svix's docs do not give a number.
- Thin events use the same signature check as snapshot events. The Stripe SDK's `parseEventNotification` calls the same `verifyHeader`.
- The verifiers here accept headers produced by the real `stripe` and `svix` packages.

**Inferred from what the documentation leaves out**

No documentation says "this cannot be done". These claims rest on finding no such option on the pages above.

- Stripe and Resend webhooks cannot be scoped by app or metadata.
- A restricted key cannot be limited to certain objects.
- Reading received mail needs `full_access`.
- Refunds and disputes do not inherit metadata, and renewal PaymentIntents do not get subscription metadata. Stripe's exceptions table does not list them, but real payloads were not inspected.
- `email.received` events do not use tags for routing.

**Not verified**

- Whether `to` and `cc` on received mail come from headers or from the envelope.
- Whether Resend retries reuse `svix-id` for email events as they do for inbox events. It is how Svix generally works, but the page says so only for inbox events.
- Whether Resend's received list returns `received_for` despite not documenting it.
- Whether Stripe or Resend disable an endpoint that keeps failing. The pages read here did not say.
