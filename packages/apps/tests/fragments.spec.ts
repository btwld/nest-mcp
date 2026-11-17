import { describe, expect, it } from "vitest";
import {
	MCP_APP_RESOURCE_MIME_TYPE,
	McpAppsValidationErrorCode,
	createMcpAppResourceContent,
	createMcpAppResourceFragment,
	createMcpAppTextFallback,
	createMcpAppToolFragment,
} from "../src/index.ts";

const RESOURCE_URI = "ui://weather/current";

describe("decorator and native-registration fragments", () => {
	it("builds a tool fragment with stable nested and compatibility metadata", () => {
		expect(
			createMcpAppToolFragment({
				resourceUri: RESOURCE_URI,
				visibility: ["model", "app"],
				metadata: { audit: "weather" },
			}),
		).toEqual({
			_meta: {
				audit: "weather",
				ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] },
				"ui/resourceUri": RESOURCE_URI,
			},
		});
	});

	it("supports App-only tools and canonical-only output", () => {
		expect(
			createMcpAppToolFragment({
				resourceUri: RESOURCE_URI,
				visibility: ["app"],
				includeDeprecatedResourceUri: false,
			}),
		).toEqual({
			_meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
		});
	});

	it("owns the nested ui key so callers cannot accidentally replace validated metadata", () => {
		expect(() =>
			createMcpAppToolFragment({ resourceUri: RESOURCE_URI, metadata: { ui: {} } }),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMetadata }));
		expect(() => createMcpAppResourceFragment({ metadata: { ui: {} } })).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMetadata }),
		);
	});

	it("builds a resource fragment with the exact MIME and validated metadata", () => {
		expect(
			createMcpAppResourceFragment({
				csp: {
					connectDomains: ["https://api.example.com"],
					resourceDomains: ["https://cdn.example.com"],
				},
				permissions: { geolocation: {} },
				prefersBorder: true,
				metadata: { audience: "public" },
			}),
		).toEqual({
			mimeType: MCP_APP_RESOURCE_MIME_TYPE,
			_meta: {
				audience: "public",
				ui: {
					csp: {
						connectDomains: ["https://api.example.com"],
						resourceDomains: ["https://cdn.example.com"],
					},
					permissions: { geolocation: {} },
					prefersBorder: true,
				},
			},
		});
	});
});

describe("resource content and non-App fallback fragments", () => {
	it("builds text and blob resource content with metadata on the read result", () => {
		expect(
			createMcpAppResourceContent({
				uri: RESOURCE_URI,
				text: "<!doctype html><title>Weather</title>",
				prefersBorder: false,
			}),
		).toEqual({
			uri: RESOURCE_URI,
			mimeType: MCP_APP_RESOURCE_MIME_TYPE,
			text: "<!doctype html><title>Weather</title>",
			_meta: { ui: { prefersBorder: false } },
		});
		expect(
			createMcpAppResourceContent({ uri: RESOURCE_URI, blob: "PGh0bWw+PC9odG1sPg==" }),
		).toEqual({
			uri: RESOURCE_URI,
			mimeType: MCP_APP_RESOURCE_MIME_TYPE,
			blob: "PGh0bWw+PC9odG1sPg==",
		});
	});

	it("rejects missing, duplicate, or wrong-MIME content fields", () => {
		expect(() =>
			Reflect.apply(createMcpAppResourceContent, undefined, [{ uri: RESOURCE_URI }]),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidContent }));
		expect(() =>
			Reflect.apply(createMcpAppResourceContent, undefined, [
				{ uri: RESOURCE_URI, text: "<p>x</p>", blob: "PHA+eDwvcD4=" },
			]),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidContent }));
		expect(() =>
			createMcpAppResourceContent({
				uri: RESOURCE_URI,
				mimeType: "text/html",
				text: "<p>x</p>",
			}),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMimeType }));
	});

	it("creates a useful text fallback and rejects empty guidance", () => {
		expect(createMcpAppTextFallback("Current temperature: 21 °C.")).toEqual({
			content: [{ type: "text", text: "Current temperature: 21 °C." }],
		});
		for (const value of ["", "   "]) {
			expect(() => createMcpAppTextFallback(value)).toThrowError(
				expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidFallback }),
			);
		}
	});
});
