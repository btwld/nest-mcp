import { describe, expect, it } from "vitest";
import { GatewayNameCodec, McpGatewayError } from "../src/index.ts";

describe("GatewayNameCodec", () => {
	it("round-trips separator-like and Unicode names", () => {
		const codec = new GatewayNameCodec();
		const encoded = codec.encode("team__weather.東京", "forecast__hourly.🌦️");

		expect(codec.decode(encoded)).toEqual({
			upstreamName: "team__weather.東京",
			toolName: "forecast__hourly.🌦️",
		});
	});

	it("does not collide when boundaries move between components", () => {
		const codec = new GatewayNameCodec();
		const first = codec.encode("alpha__beta", "gamma");
		const second = codec.encode("alpha", "beta__gamma");

		expect(first).not.toBe(second);
		expect(codec.decode(first)).toEqual({
			upstreamName: "alpha__beta",
			toolName: "gamma",
		});
		expect(codec.decode(second)).toEqual({
			upstreamName: "alpha",
			toolName: "beta__gamma",
		});
	});

	it("rejects non-canonical and foreign names", () => {
		const codec = new GatewayNameCodec();

		expect(codec.tryDecode("other.YWxwaGE.ZWNobw")).toBeUndefined();
		expect(() => codec.decode("gw1.YWxwaGE=.ZWNobw")).toThrow(McpGatewayError);
		expect(() => codec.decode("gw1..ZWNobw")).toThrow(McpGatewayError);
	});

	it("rejects projections beyond the MCP 128-character tool-name guidance", () => {
		const codec = new GatewayNameCodec();

		expect(() => codec.encode("upstream", "x".repeat(128))).toThrow(
			expect.objectContaining({
				code: "INVALID_PROJECTED_NAME",
				message: expect.stringContaining("exceeds 128 characters"),
			}),
		);
	});
});
