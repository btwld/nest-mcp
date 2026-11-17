import { describe, expect, it } from "vitest";
import {
	McpAppsValidationErrorCode,
	assertMcpAppResourceLinks,
	createMcpAppToolFragment,
} from "../src/index.ts";

describe("App tool/resource linkage", () => {
	it("accepts nested and deprecated tool references with registered resources", () => {
		expect(() =>
			assertMcpAppResourceLinks(
				[
					{
						name: "weather",
						...createMcpAppToolFragment({ resourceUri: "ui://weather/current" }),
					},
					{
						name: "clock",
						_meta: { "ui/resourceUri": "ui://clock/current" },
					},
				],
				[{ uri: "ui://weather/current" }, { uri: "ui://clock/current" }],
			),
		).not.toThrow();
	});

	it("ignores non-App tools and UI tools without a resource link", () => {
		expect(() =>
			assertMcpAppResourceLinks(
				[
					{ name: "plain", _meta: { audit: "public" } },
					{ name: "app-action", _meta: { ui: { visibility: ["app"] } } },
				],
				[{ uri: "file://ordinary/readme.md", mimeType: "text/markdown" }],
			),
		).not.toThrow();
	});

	it("rejects a tool link that would fail resources/read", () => {
		expect(() =>
			assertMcpAppResourceLinks(
				[
					{
						name: "weather",
						...createMcpAppToolFragment({ resourceUri: "ui://weather/missing" }),
					},
				],
				[{ uri: "ui://weather/other" }],
			),
		).toThrowError(
			expect.objectContaining({
				code: McpAppsValidationErrorCode.MissingResource,
				path: 'tool "weather" resource link',
			}),
		);
	});

	it("validates App-marked resource URIs and rejects conflicting metadata", () => {
		expect(() =>
			assertMcpAppResourceLinks(
				[],
				[{ uri: "https://example.com/view", mimeType: "text/html;profile=mcp-app" }],
			),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidUri }));
		expect(() =>
			assertMcpAppResourceLinks(
				[{ name: "wrong-mime", _meta: { ui: { resourceUri: "ui://wrong-mime" } } }],
				[{ uri: "ui://wrong-mime", mimeType: "text/plain" }],
			),
		).toThrowError(expect.objectContaining({ code: McpAppsValidationErrorCode.InvalidMimeType }));
		expect(() =>
			assertMcpAppResourceLinks(
				[
					{
						name: "conflict",
						_meta: {
							ui: { resourceUri: "ui://new" },
							"ui/resourceUri": "ui://old",
						},
					},
				],
				[],
			),
		).toThrowError(
			expect.objectContaining({ code: McpAppsValidationErrorCode.ConflictingResourceUri }),
		);
	});
});
