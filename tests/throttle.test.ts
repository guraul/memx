import { describe, it, expect, beforeEach } from "vitest";
import { shouldRun, markRun, resetThrottle } from "../src/core/llm/throttle";

describe("throttle", () => {
  beforeEach(() => {
    resetThrottle();
  });

  it("returns true when never run before", () => {
    expect(shouldRun(10)).toBe(true);
  });

  it("returns false immediately after markRun", () => {
    markRun();
    expect(shouldRun(10)).toBe(false);
  });

  it("returns true after throttle window passes", () => {
    markRun();
    expect(shouldRun(0)).toBe(true);
  });

  it("uses default 10 minutes", () => {
    markRun();
    expect(shouldRun()).toBe(false);
  });
});
