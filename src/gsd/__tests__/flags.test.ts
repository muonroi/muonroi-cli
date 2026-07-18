import { afterEach, describe, expect, it } from "vitest";
import { isGsdNativeEnabled, isPilGateEnrichEnabled } from "../flags.js";

describe("isGsdNativeEnabled", () => {
  const prev = process.env.MUONROI_GSD_NATIVE;

  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_GSD_NATIVE;
    else process.env.MUONROI_GSD_NATIVE = prev;
  });

  it("defaults to enabled when env unset", () => {
    delete process.env.MUONROI_GSD_NATIVE;
    expect(isGsdNativeEnabled()).toBe(true);
  });

  it("stays enabled when MUONROI_GSD_NATIVE=1", () => {
    process.env.MUONROI_GSD_NATIVE = "1";
    expect(isGsdNativeEnabled()).toBe(true);
  });

  it("opts out when MUONROI_GSD_NATIVE=0", () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    expect(isGsdNativeEnabled()).toBe(false);
  });
});

describe("isPilGateEnrichEnabled", () => {
  const orig = { native: process.env.MUONROI_GSD_NATIVE, enrich: process.env.MUONROI_PIL_GATE_ENRICH };
  afterEach(() => {
    process.env.MUONROI_GSD_NATIVE = orig.native;
    process.env.MUONROI_PIL_GATE_ENRICH = orig.enrich;
  });
  it("defaults on with native GSD", () => {
    delete process.env.MUONROI_GSD_NATIVE;
    delete process.env.MUONROI_PIL_GATE_ENRICH;
    expect(isPilGateEnrichEnabled()).toBe(true);
  });
  it("off when explicitly disabled", () => {
    process.env.MUONROI_PIL_GATE_ENRICH = "0";
    expect(isPilGateEnrichEnabled()).toBe(false);
  });
  it("off when native GSD is off (coupling)", () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    delete process.env.MUONROI_PIL_GATE_ENRICH;
    expect(isPilGateEnrichEnabled()).toBe(false);
  });
});

describe("isEeConnectCardEnabled", () => {
  const prev = process.env.MUONROI_EE_CONNECT_CARD;

  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_EE_CONNECT_CARD;
    else process.env.MUONROI_EE_CONNECT_CARD = prev;
  });

  it("defaults to enabled when env unset", async () => {
    delete process.env.MUONROI_EE_CONNECT_CARD;
    const { isEeConnectCardEnabled } = await import("../flags.js");
    expect(isEeConnectCardEnabled()).toBe(true);
  });

  it("opts out when MUONROI_EE_CONNECT_CARD=0", async () => {
    process.env.MUONROI_EE_CONNECT_CARD = "0";
    const { isEeConnectCardEnabled } = await import("../flags.js");
    expect(isEeConnectCardEnabled()).toBe(false);
  });

  it("opts out when MUONROI_EE_CONNECT_CARD=false", async () => {
    process.env.MUONROI_EE_CONNECT_CARD = "false";
    const { isEeConnectCardEnabled } = await import("../flags.js");
    expect(isEeConnectCardEnabled()).toBe(false);
  });
});
