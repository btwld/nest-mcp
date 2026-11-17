import { describe, expect, it } from "vitest";

import { parseOAuthCallbackMarker, stripOAuthCallbackMarker } from "../lib/oauth-callback";

const connectionId = "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71";

describe("OAuth callback markers", () => {
  it("parses only bounded, redacted callback results", () => {
    expect(parseOAuthCallbackMarker(`?oauth=authorized&connectionId=${connectionId}`)).toEqual({
      outcome: "authorized",
      connectionId,
    });
    expect(
      parseOAuthCallbackMarker(
        `?oauth=failed&connectionId=${connectionId}&code=OAUTH_ACCESS_DENIED`,
      ),
    ).toEqual({ outcome: "failed", connectionId, code: "OAUTH_ACCESS_DENIED" });
    expect(parseOAuthCallbackMarker("?view=metrics")).toBeNull();
  });

  it("rejects duplicate, unsafe, or provider-shaped callback values", () => {
    for (const search of [
      `?oauth=authorized&oauth=failed&connectionId=${connectionId}`,
      "?oauth=authorized&connectionId=not-a-uuid",
      `?oauth=failed&connectionId=${connectionId}&code=access denied: token=secret`,
      `?oauth=authorized&connectionId=${connectionId}&code=provider-code`,
    ]) {
      expect(parseOAuthCallbackMarker(search)).toEqual({ outcome: "invalid" });
    }
  });

  it("removes callback markers immediately while preserving unrelated navigation state", () => {
    const url = new URL(
      `http://127.0.0.1:5173/?view=metrics&oauth=failed&connectionId=${connectionId}&code=OAUTH_DENIED#activity`,
    );

    expect(stripOAuthCallbackMarker(url)).toBe("/?view=metrics#activity");
  });
});
