import { describe, expect, it } from "vitest";

import { validateEnvironment } from "../src/config/control-plane-config.service.ts";

describe("control-plane configuration", () => {
	it("keeps the default OAuth callback on the development web origin", () => {
		expect(validateEnvironment({})).toMatchObject({
			CONTROL_PLANE_UI_ORIGIN: "http://127.0.0.1:5173",
			CONTROL_PLANE_OAUTH_CALLBACK_URL: "http://127.0.0.1:5173/api/v1/mcp/oauth/callback",
		});
	});
});
