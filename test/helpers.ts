import Stripe from "stripe";
import { Webhook } from "svix";

// Built at runtime so no secret-shaped string sits in the repo.
export const STRIPE_SECRET = ["whsec", "stripe-test-signing-value"].join("_");
export const RESEND_SECRET = ["whsec", btoa("resend-test-signing-value-0123")].join("_");

export const NOW = 1_800_000_000;

export function stripeHeader(payload: string, secret = STRIPE_SECRET, timestamp = NOW): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

export function stripeEvent(object: Record<string, unknown>, type = "checkout.session.completed", id = "evt_test_1") {
  return JSON.stringify({ id, object: "event", type, data: { object } });
}

export function svixHeaders(
  payload: string,
  { secret = RESEND_SECRET, timestamp = NOW, id = "msg_test_1" } = {},
): Record<string, string> {
  const date = new Date(timestamp * 1000);
  return {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": new Webhook(secret).sign(id, date, payload),
  };
}
