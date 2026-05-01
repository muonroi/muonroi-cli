/**
 * usd-meter.test.tsx -- tests for UsdMeter component.
 */
import { describe, expect, it } from "vitest";
import { UsdMeter } from "./usd-meter.js";

describe("UsdMeter", () => {
  it("renders session and month USD formatted to 2 decimals", () => {
    const el = UsdMeter({ session_usd: 3.5, month_usd: 10.123, current_pct: 40 }) as any;
    expect(el.props.children).toBe("session: $3.50 | month: $10.12");
  });

  it("renders white color when current_pct < 50", () => {
    const el = UsdMeter({ session_usd: 0, month_usd: 0, current_pct: 20 }) as any;
    expect(el.props.color).toBe("white");
  });

  it("renders cyan color when current_pct >= 50 and < 80", () => {
    const el = UsdMeter({ session_usd: 0, month_usd: 0, current_pct: 55 }) as any;
    expect(el.props.color).toBe("cyan");
  });

  it("renders yellow color when current_pct >= 80 and < 100", () => {
    const el = UsdMeter({ session_usd: 0, month_usd: 0, current_pct: 80 }) as any;
    expect(el.props.color).toBe("yellow");
  });

  it("renders red color when current_pct >= 100", () => {
    const el = UsdMeter({ session_usd: 0, month_usd: 0, current_pct: 100 }) as any;
    expect(el.props.color).toBe("red");
  });

  it("has data-testid usd-meter", () => {
    const el = UsdMeter({ session_usd: 0, month_usd: 0, current_pct: 0 }) as any;
    expect(el.props["data-testid"]).toBe("usd-meter");
  });
});
