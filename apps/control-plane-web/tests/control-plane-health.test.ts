import { describe, expect, it } from "vitest";

import { deriveControlPlaneHealthStatus } from "../lib/control-plane-health";

describe("deriveControlPlaneHealthStatus", () => {
  it.each([
    {
      label: "checks until liveness is observed",
      input: { live: undefined, ready: undefined, liveFailed: false, readyFailed: false },
      expected: "checking",
    },
    {
      label: "reports an unreachable API when liveness fails",
      input: { live: undefined, ready: undefined, liveFailed: true, readyFailed: true },
      expected: "unreachable",
    },
    {
      label: "distinguishes a live but unready API",
      input: {
        live: { status: "live" as const },
        ready: undefined,
        liveFailed: false,
        readyFailed: true,
      },
      expected: "not-ready",
    },
    {
      label: "reports ready only after both checks succeed",
      input: {
        live: { status: "live" as const },
        ready: { status: "ready" as const },
        liveFailed: false,
        readyFailed: false,
      },
      expected: "ready",
    },
  ])("$label", ({ input, expected }) => {
    expect(deriveControlPlaneHealthStatus(input)).toBe(expected);
  });
});
