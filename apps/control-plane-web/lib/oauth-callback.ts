import { z } from "zod";

const connectionIdSchema = z.string().uuid();
const callbackCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);

export type OAuthCallbackMarker =
  | {
      readonly outcome: "authorized";
      readonly connectionId: string;
    }
  | {
      readonly outcome: "failed";
      readonly connectionId: string;
      readonly code?: string;
    }
  | {
      readonly outcome: "invalid";
    };

export function parseOAuthCallbackMarker(search: string): OAuthCallbackMarker | null {
  const parameters = new URLSearchParams(search);
  const outcomes = parameters.getAll("oauth");
  if (outcomes.length === 0) return null;

  const connectionIds = parameters.getAll("connectionId");
  const codes = parameters.getAll("code");
  if (outcomes.length !== 1 || connectionIds.length !== 1 || codes.length > 1) {
    return { outcome: "invalid" };
  }

  const outcome = outcomes[0];
  const connectionId = connectionIdSchema.safeParse(connectionIds[0]);
  if (!connectionId.success) return { outcome: "invalid" };

  if (outcome === "authorized" && codes.length === 0) {
    return { outcome, connectionId: connectionId.data };
  }

  if (outcome === "failed") {
    if (codes.length === 0) return { outcome, connectionId: connectionId.data };
    const code = callbackCodeSchema.safeParse(codes[0]);
    if (code.success) return { outcome, connectionId: connectionId.data, code: code.data };
  }

  return { outcome: "invalid" };
}

export function stripOAuthCallbackMarker(url: URL): string {
  url.searchParams.delete("oauth");
  url.searchParams.delete("connectionId");
  url.searchParams.delete("code");
  return `${url.pathname}${url.search}${url.hash}`;
}
