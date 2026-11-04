import { afterEach, describe, expect, it } from "vitest";
import { isFlowNativeEnabled, isPilGateEnrichEnabled } from "../flags.js";

describe("isFlowNativeEnabled", () => {
  const prev = process.env.MUONROI_FLOW_NATIVE;

  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_FLOW_NATIVE;
    else process.env.MUONROI_FLOW_NATIVE = prev;
  });

  it("defaults to enabled when env unset", () => {
    delete process.env.MUONROI_FLOW_NATIVE;
    expect(isFlowNativeEnabled()).toBe(true);
  });

  it("stays enabled when MUONROI_FLOW_NATIVE=1", () => {
    process.env.MUONROI_FLOW_NATIVE = "1";
    expect(isFlowNativeEnabled()).toBe(true);
  });

  it("opts out when MUONROI_FLOW_NATIVE=0", () => {
    process.env.MUONROI_FLOW_NATIVE = "0";
    expect(isFlowNativeEnabled()).toBe(false);
  });
});

describe("isPilGateEnrichEnabled", () => {
  const orig = { native: process.env.MUONROI_FLOW_NATIVE, enrich: process.env.MUONROI_PIL_GATE_ENRICH };
  afterEach(() => {
    process.env.MUONROI_FLOW_NATIVE = orig.native;
    process.env.MUONROI_PIL_GATE_ENRICH = orig.enrich;
  });
  it("defaults on with native FLOW", () => {
    delete process.env.MUONROI_FLOW_NATIVE;
    delete process.env.MUONROI_PIL_GATE_ENRICH;
    expect(isPilGateEnrichEnabled()).toBe(true);
  });
  it("off when explicitly disabled", () => {
    process.env.MUONROI_PIL_GATE_ENRICH = "0";
    expect(isPilGateEnrichEnabled()).toBe(false);
  });
  it("off when native FLOW is off (coupling)", () => {
    process.env.MUONROI_FLOW_NATIVE = "0";
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

describe("isLspSetupCardEnabled", () => {
  const prev = process.env.MUONROI_LSP_SETUP_CARD;

  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_LSP_SETUP_CARD;
    else process.env.MUONROI_LSP_SETUP_CARD = prev;
  });

  it("defaults to enabled when env unset", async () => {
    delete process.env.MUONROI_LSP_SETUP_CARD;
    const { isLspSetupCardEnabled } = await import("../flags.js");
    expect(isLspSetupCardEnabled()).toBe(true);
  });

  it("opts out when MUONROI_LSP_SETUP_CARD=0", async () => {
    process.env.MUONROI_LSP_SETUP_CARD = "0";
    const { isLspSetupCardEnabled } = await import("../flags.js");
    expect(isLspSetupCardEnabled()).toBe(false);
  });

  it("opts out when MUONROI_LSP_SETUP_CARD=false", async () => {
    process.env.MUONROI_LSP_SETUP_CARD = "false";
    const { isLspSetupCardEnabled } = await import("../flags.js");
    expect(isLspSetupCardEnabled()).toBe(false);
  });
});
