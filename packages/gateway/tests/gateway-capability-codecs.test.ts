import { describe, expect, it } from "vitest";
import {
	GatewayPromptNameCodec,
	GatewayResourceTemplateUriCodec,
	GatewayResourceUriCodec,
	McpGatewayError,
} from "../src/index.ts";

describe("GatewayPromptNameCodec", () => {
	it("round-trips Unicode without collisions", () => {
		const codec = new GatewayPromptNameCodec();
		const first = codec.encode("a/b", "c.東京");
		const second = codec.encode("a", "b/c.東京");
		expect(first).not.toBe(second);
		expect(codec.decode(first)).toEqual({ upstreamName: "a/b", promptName: "c.東京" });
	});

	it("rejects names beyond the 128-character bound", () => {
		const codec = new GatewayPromptNameCodec();
		expect(() => codec.encode("upstream", "p".repeat(128))).toThrow(McpGatewayError);
	});
});

describe("GatewayResourceUriCodec", () => {
	it("round-trips absolute URIs as a reversible non-plaintext namespace", () => {
		const codec = new GatewayResourceUriCodec();
		const raw = "tenant+opaque://日本語/customer-42?classification=internal#fragment";
		const encoded = codec.encode("team/東京", raw);

		expect(encoded).not.toContain("customer-42");
		expect(codec.decode(encoded)).toEqual({ upstreamName: "team/東京", resourceUri: raw });
		expect(codec.tryDecode(`${encoded}?ambiguous=true`)).toBeUndefined();
	});

	it("rejects relative upstream URIs and enforces the configured bound", () => {
		const codec = new GatewayResourceUriCodec({ maxProjectedUriLength: 50 });
		expect(() => codec.encode("upstream", "/relative")).toThrow(TypeError);
		expect(() => codec.encode("upstream", `test://${"x".repeat(80)}`)).toThrow(
			expect.objectContaining({ code: "INVALID_PROJECTED_URI" }),
		);
	});

	it("rejects URI userinfo credentials", () => {
		const codec = new GatewayResourceUriCodec();
		expect(() => codec.encode("upstream", "https://user:password@example.test/file")).toThrow(
			TypeError,
		);
	});
});

describe("GatewayResourceTemplateUriCodec", () => {
	it("projects every template variable and reverses the canonical route", () => {
		const codec = new GatewayResourceTemplateUriCodec();
		const raw = "https://example.test/tenant/{tenant}/notes/{id}{?view}";
		const projected = codec.encode("team/東京", raw);

		expect(projected).toMatch(/\/values\/\{tenant\}\/\{id\}\/\{view\}$/);
		expect(projected).not.toContain("example.test");
		expect(codec.decode(projected)).toEqual({
			upstreamName: "team/東京",
			resourceTemplate: raw,
		});
		expect(codec.tryDecode(`${projected}/extra`)).toBeUndefined();
	});

	it("rejects static URIs, credential-bearing expansions, and configured limits", () => {
		const codec = new GatewayResourceTemplateUriCodec({ maxVariables: 1 });
		expect(() => codec.encode("primary", "https://example.test/static")).toThrow(TypeError);
		expect(() => codec.encode("primary", "https://user:pass@example.test/{id}")).toThrow(TypeError);
		expect(() => codec.encode("primary", "https://example.test/{one}/{two}")).toThrow(
			expect.objectContaining({ code: "INVALID_PROJECTED_TEMPLATE_URI" }),
		);
		expect(() => codec.encode("primary", "https://example.test/{ids*}")).toThrow(TypeError);
		expect(() => codec.encode("primary", "https://example.test/{first,last}")).toThrow(TypeError);
	});
});
