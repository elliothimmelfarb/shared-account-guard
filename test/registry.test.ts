import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRegistry, resendOptionsFor, type Registry } from "../src/index.js";

const example = JSON.parse(readFileSync("examples/registry.example.json", "utf8")) as Registry;
const clone = () => structuredClone(example);

describe("checkRegistry", () => {
  it("passes the sample registry", () => {
    expect(checkRegistry(example)).toEqual([]);
  });

  it("flags two apps receiving on one domain", () => {
    const reg = clone();
    reg.apps[1]!.resend!.receivingDomains = reg.apps[0]!.resend!.receivingDomains;
    expect(checkRegistry(reg).join()).toMatch(/receiv/);
  });

  it("flags two apps sending from one domain that is not declared shared", () => {
    const reg = clone();
    reg.apps[1]!.resend!.sendingDomains = reg.apps[0]!.resend!.sendingDomains;
    expect(checkRegistry(reg).join()).toMatch(/shared/);
  });

  it("flags a webhook URL used twice", () => {
    const reg = clone();
    reg.apps[1]!.stripe!.webhook = reg.apps[0]!.stripe!.webhook;
    expect(checkRegistry(reg).join()).toMatch(/webhook/);
  });

  it("flags a duplicate or invalid id", () => {
    const reg = clone();
    reg.apps[1]!.id = reg.apps[0]!.id;
    reg.apps[2]!.id = "has a space";
    const problems = checkRegistry(reg).join();
    expect(problems).toMatch(/twice/);
    expect(problems).toMatch(/has a space/);
  });
});

describe("resendOptionsFor", () => {
  it("builds guard options from the registry, including the shared domains", () => {
    const options = resendOptionsFor(example, example.apps[0]!.id);
    expect(options.receivingDomains).toEqual(example.apps[0]!.resend!.receivingDomains);
    expect(options.sharedSendingDomains).toEqual(example.resend?.sharedSendingDomains);
  });

  it("throws for an unknown app rather than returning options that match nothing", () => {
    expect(() => resendOptionsFor(example, "nobody")).toThrow(/nobody/);
  });
});
