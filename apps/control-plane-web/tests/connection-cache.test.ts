import { describe, expect, it } from "vitest";

import type { Connection } from "../lib/control-plane-api";
import { mergeConnection, mergeObservedRuntime } from "../lib/connection-cache";

const base: Connection = {
  id: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
  revision: 3,
  runtimeGeneration: 2,
  displayName: "Docs",
  desiredState: "online",
  deletionPending: false,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:01:00.000Z",
  transport: { kind: "http", host: "127.0.0.1:3200" },
  authentication: { kind: "none", configured: true },
  runtime: { phase: "online", lastTransitionAt: "2026-08-21T12:01:00.000Z" },
};

describe("connection cache fencing", () => {
  it("does not let an older mutation response overwrite a newer revision", () => {
    const stale = { ...base, revision: 2, displayName: "Stale" };
    expect(mergeConnection([base], stale)).toEqual([base]);
  });

  it("applies probe state only to the exact revision and runtime generation", () => {
    const degraded = { phase: "degraded" as const, lastTransitionAt: base.updatedAt };
    expect(mergeObservedRuntime([base], { ...base, runtimeGeneration: 1 }, degraded)).toEqual([
      base,
    ]);
    expect(mergeObservedRuntime([base], base, degraded)?.[0]?.runtime.phase).toBe("degraded");
  });
});
