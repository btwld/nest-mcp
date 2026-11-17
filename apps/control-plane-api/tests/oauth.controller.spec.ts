import { describe, expect, it } from "vitest";

import { createApplication } from "../src/bootstrap.ts";

describe("OAuthController", () => {
	it("uses native no-store redirects with a strictly redacted UI failure marker", async () => {
		const app = await createApplication({ logger: false, swagger: false });
		try {
			const created = await app.inject({
				method: "POST",
				url: "/v1/mcp/connections",
				payload: {
					displayName: "OAuth redirect",
					endpoint: "http://127.0.0.1:65534/mcp",
					desiredState: "online",
					authentication: { kind: "oauth" },
				},
			});
			expect(created.statusCode).toBe(201);
			const connection = created.json<{ id: string; revision: number; desiredState: string }>();
			expect(connection.desiredState).toBe("offline");

			const started = await app.inject({
				method: "POST",
				url: `/v1/mcp/connections/${connection.id}/oauth/authorize?expectedRevision=${String(connection.revision)}`,
			});
			expect(started.statusCode).toBe(303);
			expect(started.headers["cache-control"]).toBe("no-store");
			expect(started.headers["referrer-policy"]).toBe("no-referrer");
			const redirect = new URL(String(started.headers.location));
			expect([...redirect.searchParams.keys()].toSorted()).toEqual([
				"code",
				"connectionId",
				"oauth",
			]);
			expect(redirect.searchParams.get("oauth")).toBe("failed");
			expect(redirect.searchParams.get("connectionId")).toBe(connection.id);
			expect(String(started.headers.location)).not.toMatch(
				/access_token|refresh_token|client_secret|code_verifier|state=/u,
			);
		} finally {
			await app.close();
		}
	});
});
