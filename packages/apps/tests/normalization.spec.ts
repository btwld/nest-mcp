import { describe, expect, it } from "vitest";
import {
	MCP_APP_DEFAULT_TOOL_VISIBILITY,
	MCP_APP_RESOURCE_MIME_TYPE,
	MCP_APP_RESOURCE_URI_META_KEY,
	MCP_APPS_EXTENSION_ID,
	MCP_APPS_SPEC_VERSION,
	McpAppsValidationErrorCode,
	isMcpAppResourceUri,
	normalizeMcpAppResourceCsp,
	normalizeMcpAppResourceMeta,
	normalizeMcpAppResourceMetadata,
	normalizeMcpAppResourceMimeType,
	normalizeMcpAppResourcePermissions,
	normalizeMcpAppResourceUri,
	normalizeMcpAppsClientCapability,
	normalizeMcpAppToolMetadata,
	normalizeMcpAppToolVisibility,
} from "../src/index.ts";

// Wire examples are pinned to the official stable specification snapshot:
// https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/specification/2026-01-26/apps.mdx

describe("stable MCP Apps constants", () => {
	it("pins the 2026-01-26 wire values", () => {
		expect(MCP_APPS_SPEC_VERSION).toBe("2026-01-26");
		expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
		expect(MCP_APP_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
		expect(MCP_APP_RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
		expect(MCP_APP_DEFAULT_TOOL_VISIBILITY).toEqual(["model", "app"]);
	});
});

describe("resource URI and MIME normalization", () => {
	it("accepts only a non-empty exact ui:// URI", () => {
		expect(isMcpAppResourceUri("ui://weather/current")).toBe(true);
		expect(isMcpAppResourceUri("https://example.com/view")).toBe(false);
		expect(normalizeMcpAppResourceUri("ui://weather/current")).toBe("ui://weather/current");
		for (const value of [
			"UI://weather/current",
			"ui://",
			"ui://weather bad",
			"ui://weather\u00a0view",
			"https://x",
		]) {
			expect(() => normalizeMcpAppResourceUri(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidUri }),
			);
		}
	});

	it("defaults and validates the exact stable HTML MIME", () => {
		expect(normalizeMcpAppResourceMimeType()).toBe("text/html;profile=mcp-app");
		expect(() => normalizeMcpAppResourceMimeType("text/html")).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMimeType }),
		);
	});
});

describe("tool metadata normalization", () => {
	it("applies the default visibility while preserving an explicit empty list", () => {
		expect(normalizeMcpAppToolVisibility()).toEqual(["model", "app"]);
		expect(normalizeMcpAppToolVisibility([])).toEqual([]);
		expect(normalizeMcpAppToolVisibility(["app", "app", "model"])).toEqual(["app", "model"]);
	});

	it("rejects invalid visibility values", () => {
		for (const value of ["app", ["host"], [1]]) {
			expect(() => normalizeMcpAppToolVisibility(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidVisibility }),
			);
		}
	});

	it("normalizes nested metadata and mirrors the deprecated flat URI", () => {
		const input = {
			audit: { owner: "weather" },
			ui: { resourceUri: "ui://weather/current", visibility: ["model"] },
		};
		const normalized = normalizeMcpAppToolMetadata(input);

		expect(normalized).toEqual({
			audit: { owner: "weather" },
			ui: { resourceUri: "ui://weather/current", visibility: ["model"] },
			"ui/resourceUri": "ui://weather/current",
		});
		expect(input).toEqual({
			audit: { owner: "weather" },
			ui: { resourceUri: "ui://weather/current", visibility: ["model"] },
		});
	});

	it("upgrades deprecated flat metadata and can emit canonical-only metadata", () => {
		expect(normalizeMcpAppToolMetadata({ "ui/resourceUri": "ui://weather/current" })).toEqual({
			ui: { resourceUri: "ui://weather/current", visibility: ["model", "app"] },
			"ui/resourceUri": "ui://weather/current",
		});
		expect(
			normalizeMcpAppToolMetadata(
				{ "ui/resourceUri": "ui://weather/current" },
				{ includeDeprecatedResourceUri: false },
			),
		).toEqual({
			ui: { resourceUri: "ui://weather/current", visibility: ["model", "app"] },
		});
	});

	it("rejects conflicting URIs and resource-only fields on tools", () => {
		expect(() =>
			normalizeMcpAppToolMetadata({
				ui: { resourceUri: "ui://new" },
				"ui/resourceUri": "ui://old",
			}),
		).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.ConflictingResourceUri }),
		);
		expect(() => normalizeMcpAppToolMetadata({ ui: { csp: {} } })).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMetadata }),
		);
	});
});

describe("resource metadata normalization", () => {
	it("normalizes and deduplicates CSP origins", () => {
		expect(
			normalizeMcpAppResourceCsp({
				connectDomains: [
					"HTTPS://API.Example.com:443",
					"https://api.example.com",
					"wss://events.example.com",
				],
				resourceDomains: ["https://cdn.example.com"],
				frameDomains: ["https://*.widgets.example.com:443"],
				baseUriDomains: [],
			}),
		).toEqual({
			connectDomains: ["https://api.example.com", "wss://events.example.com"],
			resourceDomains: ["https://cdn.example.com"],
			frameDomains: ["https://*.widgets.example.com"],
			baseUriDomains: [],
		});
	});

	it("rejects unknown CSP keys and non-origin values", () => {
		for (const value of [
			{ scriptDomains: ["https://cdn.example.com"] },
			{ resourceDomains: "https://cdn.example.com" },
			{ resourceDomains: ["https://cdn.example.com/app.js"] },
			{ frameDomains: ["wss://frames.example.com"] },
			{ connectDomains: ["https://user:secret@example.com"] },
		]) {
			expect(() => normalizeMcpAppResourceCsp(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidCsp }),
			);
		}
	});

	it("accepts only stable permission names with empty-object markers", () => {
		expect(
			normalizeMcpAppResourcePermissions({
				camera: {},
				microphone: {},
				geolocation: {},
				clipboardWrite: {},
			}),
		).toEqual({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} });
		for (const value of [{ notifications: {} }, { camera: true }, { camera: { mode: "on" } }]) {
			expect(() => normalizeMcpAppResourcePermissions(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidPermissions }),
			);
		}
	});

	it("normalizes the full stable resource metadata shape and preserves peers", () => {
		expect(
			normalizeMcpAppResourceMetadata({
				audit: "public",
				ui: {
					csp: { connectDomains: ["https://api.example.com"] },
					permissions: { clipboardWrite: {} },
					domain: "weather.example.com",
					prefersBorder: true,
				},
			}),
		).toEqual({
			audit: "public",
			ui: {
				csp: { connectDomains: ["https://api.example.com"] },
				permissions: { clipboardWrite: {} },
				domain: "weather.example.com",
				prefersBorder: true,
			},
		});
	});

	it("rejects unknown resource UI fields and invalid domain/border values", () => {
		for (const value of [
			{ theme: "dark" },
			{ domain: "weather example.com" },
			{ prefersBorder: "yes" },
		]) {
			expect(() => normalizeMcpAppResourceMeta(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMetadata }),
			);
		}
	});
});

describe("client capability normalization", () => {
	it("requires string MIME entries and deduplicates them", () => {
		expect(
			normalizeMcpAppsClientCapability({
				mimeTypes: ["text/html;profile=mcp-app", "text/html;profile=mcp-app"],
			}),
		).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
		expect(() => normalizeMcpAppsClientCapability({ mimeTypes: [1] })).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMetadata }),
		);
		expect(normalizeMcpAppsClientCapability({ mimeTypes: [], futureSetting: true })).toEqual({
			mimeTypes: [],
			futureSetting: true,
		});
	});
});
