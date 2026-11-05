import { DEFAULT_TAG_KEY, isValidAppId } from "./common.js";
import type { ResendGuardOptions } from "./resend.js";
import type { StripeGuardOptions } from "./stripe.js";

/** A plain record of who owns what on the shared accounts. It holds no secrets. */
export interface Registry {
  tagKey?: string;
  resend?: { sharedSendingDomains?: string[] };
  apps: RegistryApp[];
}

export interface RegistryApp {
  id: string;
  description?: string;
  stripe?: { webhook: string };
  resend?: { webhook: string; receivingDomains: string[]; sendingDomains: string[] };
}

function repeated(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Returns one sentence per problem, or an empty list when the registry is sound. */
export function checkRegistry(registry: Registry): string[] {
  const problems: string[] = [];
  const shared = new Set(registry.resend?.sharedSendingDomains ?? []);
  const { apps } = registry;

  for (const app of apps) {
    if (!isValidAppId(app.id)) problems.push(`App id ${JSON.stringify(app.id)} is not a valid app id.`);
  }
  for (const id of repeated(apps.map((app) => app.id))) problems.push(`App id ${id} appears twice.`);

  const webhooks = apps.flatMap((app) => [app.stripe?.webhook, app.resend?.webhook]).filter((url) => url !== undefined);
  for (const url of repeated(webhooks)) problems.push(`The webhook ${url} is registered twice.`);

  const receiving = apps.flatMap((app) => app.resend?.receivingDomains ?? []);
  for (const domain of repeated(receiving)) problems.push(`Two apps are receiving on ${domain}.`);
  for (const domain of receiving) {
    if (shared.has(domain)) problems.push(`${domain} is a shared sending domain, so no app can own its inbound mail.`);
  }

  const sending = apps.flatMap((app) => app.resend?.sendingDomains ?? []);
  for (const domain of repeated(sending)) {
    if (!shared.has(domain)) problems.push(`Two apps send from ${domain}, but it is not listed as shared.`);
  }
  return problems;
}

function find(registry: Registry, id: string): RegistryApp {
  const app = registry.apps.find((candidate) => candidate.id === id);
  if (!app) throw new Error(`App ${id} is not in the registry.`);
  return app;
}

export function stripeOptionsFor(registry: Registry, id: string): StripeGuardOptions {
  return { app: find(registry, id).id, tagKey: registry.tagKey ?? DEFAULT_TAG_KEY };
}

export function resendOptionsFor(registry: Registry, id: string): ResendGuardOptions {
  const app = find(registry, id);
  return {
    app: app.id,
    receivingDomains: app.resend?.receivingDomains ?? [],
    sendingDomains: app.resend?.sendingDomains ?? [],
    sharedSendingDomains: registry.resend?.sharedSendingDomains ?? [],
    tagName: registry.tagKey ?? DEFAULT_TAG_KEY,
  };
}
