import {
	MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED,
	MCP_CONFORMANCE_CAPTURE_REJECTED,
	MCP_CONFORMANCE_CATALOG_REJECTED,
	McpConformanceCaptureError,
	canonicalizeMcpConformanceValue,
	captureMcpConformanceValue,
	captureMcpToolArguments,
	digestMcpRuntimeCatalog,
	fingerprintMcpConformanceValue,
	toMcpConformanceFingerprintHex,
	type McpConformanceCaptureOptions,
	type McpConformanceCaptureLimits,
	type McpConformanceCatalogSnapshot,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

function testLimits(
	overrides: Partial<McpConformanceCaptureLimits> = {},
): McpConformanceCaptureLimits {
	return {
		maxBytes: 65_536,
		maxDepth: 16,
		maxProperties: 512,
		maxStringBytes: 4_096,
		maxItems: 128,
		...overrides,
	};
}

/** Reports the structural failure code so a rejection table reads as data, not stack text. */
function captureFailure(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error instanceof McpConformanceCaptureError ? error.code : error;
	}
	return "no error thrown";
}

/** Verifies the whole captured tree is frozen and carries no inherited surface. */
function isFrozenNullPrototypeJson(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	if (!Object.isFrozen(value)) return false;
	if (Array.isArray(value)) return value.every((entry) => isFrozenNullPrototypeJson(entry));
	if (Object.getPrototypeOf(value) !== null) return false;
	return Object.values(value).every((entry) => isFrozenNullPrototypeJson(entry));
}

const hostileShapes: [label: string, build: () => unknown][] = [
	["a proxy", () => new Proxy({ a: 1 }, {})],
	[
		"an accessor property",
		() => Object.defineProperty({}, "a", { get: () => 1, enumerable: true, configurable: true }),
	],
	[
		"a non-enumerable property",
		() => Object.defineProperty({}, "a", { value: 1, enumerable: false, configurable: true }),
	],
	["a symbol key", () => ({ [Symbol("hostile")]: 1 })],
	[
		"a sparse array",
		() => {
			const sparse: unknown[] = [1];
			sparse.length = 3;
			return sparse;
		},
	],
	["an array carrying extra properties", () => Object.assign([1], { extra: true })],
	[
		"a subclassed array",
		() => {
			class Subclassed extends Array<unknown> {}
			return Subclassed.from([1]);
		},
	],
	[
		"a cycle",
		() => {
			const cyclic: Record<string, unknown> = {};
			cyclic["self"] = cyclic;
			return cyclic;
		},
	],
	["a NaN", () => ({ a: Number.NaN })],
	["an infinity", () => ({ a: Number.POSITIVE_INFINITY })],
	["an exotic prototype", () => new Date(0)],
	["a map", () => new Map([["a", 1]])],
	["a bigint", () => ({ a: 1n })],
	["a function", () => ({ a: () => 1 })],
	["a symbol value", () => ({ a: Symbol("hostile") })],
];

const limitCases: [
	label: string,
	build: () => unknown,
	overrides: Partial<McpConformanceCaptureLimits>,
][] = [
	["nesting deeper than maxDepth", () => ({ a: { b: { c: 1 } } }), { maxDepth: 2 }],
	["more properties than maxProperties", () => ({ a: 1, b: 2 }), { maxProperties: 1 }],
	["a string longer than maxStringBytes", () => "abcde", { maxStringBytes: 4 }],
	["an array longer than maxItems", () => [1, 2, 3], { maxItems: 2 }],
	["a canonical form wider than maxBytes", () => "abc", { maxBytes: 4 }],
];

const canonicalStrings: [label: string, text: string][] = [
	["a quote", '"'],
	["a backslash", "\\"],
	["short escapes", "\b\t\n\f\r"],
	["a control character", "\u0001"],
	["a two-byte character", "é"],
	["a three-byte character", "€"],
	["a surrogate pair", "😀"],
	["a lone high surrogate", "\ud800"],
	["a lone low surrogate", "\udc00"],
	["interleaved lone surrogates", "\ud800x\udc00"],
	["a line separator", "\u2028"],
];

describe("bounded conformance capture", () => {
	it("copies untrusted data into deep-frozen null-prototype JSON", () => {
		const source = { b: [1, { c: "x" }], a: null };

		const captured = captureMcpConformanceValue(source, testLimits());
		expect(captured).toEqual({ a: null, b: [1, { c: "x" }] });
		expect(isFrozenNullPrototypeJson(captured)).toBe(true);
		expect(isFrozenNullPrototypeJson(source)).toBe(false);
	});

	it("captures a value that canonicalizes exactly like its source", () => {
		const value = { b: [1, { c: "x" }], a: null, omitted: undefined };
		expect(canonicalizeMcpConformanceValue(captureMcpConformanceValue(value, testLimits()))).toBe(
			canonicalizeMcpConformanceValue(value),
		);
	});

	it("follows the canonicalizer's own undefined semantics", () => {
		const omitted = captureMcpConformanceValue({ kept: 1, dropped: undefined }, testLimits());
		expect(canonicalizeMcpConformanceValue(omitted)).toBe('{"kept":1}');

		const nulled = captureMcpConformanceValue([undefined, 1], testLimits());
		expect(nulled).toEqual([null, 1]);
		expect(canonicalizeMcpConformanceValue(nulled)).toBe("[null,1]");

		expect(captureFailure(() => captureMcpConformanceValue(undefined, testLimits()))).toBe(
			MCP_CONFORMANCE_CAPTURE_REJECTED,
		);
	});

	it("preserves JSON undefined semantics when that policy is explicit", () => {
		const options = { undefinedPolicy: "json" } satisfies McpConformanceCaptureOptions;

		expect(
			captureMcpConformanceValue(
				{ omitted: undefined, nested: [undefined, { omitted: undefined }] },
				testLimits(),
				options,
			),
		).toEqual({ nested: [null, {}] });
		expect(captureFailure(() => captureMcpConformanceValue(undefined, testLimits(), options))).toBe(
			MCP_CONFORMANCE_CAPTURE_REJECTED,
		);
	});

	it.each([
		["the root", undefined],
		["an object property", { undefinedValue: undefined }],
		["a nested object property", { nested: { undefinedValue: undefined } }],
		["an array entry", [undefined]],
		["a nested array entry", { nested: [1, undefined] }],
	] as const)("rejects undefined in %s under the reject policy", (_label, value) => {
		expect(
			captureFailure(() =>
				captureMcpConformanceValue(value, testLimits(), { undefinedPolicy: "reject" }),
			),
		).toBe(MCP_CONFORMANCE_CAPTURE_REJECTED);
	});

	it.each(hostileShapes)("refuses %s instead of walking it", (_label, build) => {
		expect(captureFailure(() => captureMcpConformanceValue(build(), testLimits()))).toBe(
			MCP_CONFORMANCE_CAPTURE_REJECTED,
		);
	});

	it.each(limitCases)("refuses %s", (_label, build, overrides) => {
		expect(captureFailure(() => captureMcpConformanceValue(build(), testLimits(overrides)))).toBe(
			MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED,
		);
	});

	it("rejects limits that are not positive integers inside the hard ceiling", () => {
		expect(() => captureMcpConformanceValue(1, testLimits({ maxBytes: 0 }))).toThrow(/maxBytes/u);
		expect(() => captureMcpConformanceValue(1, testLimits({ maxDepth: 1_000 }))).toThrow(
			/maxDepth/u,
		);
		expect(() => captureMcpConformanceValue(1, testLimits({ maxItems: 1.5 }))).toThrow(/maxItems/u);
	});
});

describe("bounded tool arguments", () => {
	it("returns a frozen null-prototype record with canonically ordered keys", () => {
		const captured = captureMcpToolArguments({ b: 2, a: "x" }, testLimits());
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.getPrototypeOf(captured)).toBeNull();
		expect(Object.keys(captured)).toEqual(["a", "b"]);
	});

	it("refuses argument roots that are not plain objects", () => {
		for (const root of [[], "x", 1, null, true]) {
			expect(captureFailure(() => captureMcpToolArguments(root, testLimits()))).toBe(
				MCP_CONFORMANCE_CAPTURE_REJECTED,
			);
		}
	});

	it("refuses hostile argument shapes", () => {
		expect(
			captureFailure(() => captureMcpToolArguments(new Proxy({ a: 1 }, {}), testLimits())),
		).toBe(MCP_CONFORMANCE_CAPTURE_REJECTED);
	});

	it("makes undefined rejection available to tool-argument capture", () => {
		expect(captureMcpToolArguments({ kept: 1, omitted: undefined }, testLimits())).toEqual({
			kept: 1,
		});
		expect(
			captureFailure(() =>
				captureMcpToolArguments({ kept: 1, nested: [undefined] }, testLimits(), {
					undefinedPolicy: "reject",
				}),
			),
		).toBe(MCP_CONFORMANCE_CAPTURE_REJECTED);
	});

	it.each(canonicalStrings)("spends exactly the canonical byte budget on %s", (_label, text) => {
		const value = { a: text };
		const bytes = Buffer.byteLength(canonicalizeMcpConformanceValue(value), "utf8");

		expect(captureMcpToolArguments(value, testLimits({ maxBytes: bytes }))).toEqual({ a: text });
		expect(
			captureFailure(() => captureMcpToolArguments(value, testLimits({ maxBytes: bytes - 1 }))),
		).toBe(MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED);
	});

	it("spends exactly the canonical byte budget on a mixed argument record", () => {
		const value = { z: [1, -0.5, true, null, ""], "\u0000 key": { nested: "😀" } };
		const bytes = Buffer.byteLength(canonicalizeMcpConformanceValue(value), "utf8");

		expect(captureMcpToolArguments(value, testLimits({ maxBytes: bytes }))).toEqual(value);
		expect(
			captureFailure(() => captureMcpToolArguments(value, testLimits({ maxBytes: bytes - 1 }))),
		).toBe(MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED);
	});
});

const digestOptions = {
	domain: "test/mcp/catalog/v1",
	toolSchemaDomain: "test/mcp/tool-schema/v1",
} as const;

function catalogSnapshot(): McpConformanceCatalogSnapshot {
	return {
		prompts: [{ name: "summarize" }, { name: "draft" }],
		resourceTemplates: [{ uriTemplate: "file:///{path}" }],
		resources: [{ uri: "file:///b.txt" }, { uri: "file:///a.txt" }],
		tools: [
			{ name: "beta", inputSchema: { type: "object", properties: { b: { type: "number" } } } },
			{ name: "alpha", inputSchema: { type: "object" } },
		],
	};
}

/** Feeds a snapshot the declared type forbids, because the runtime contract must refuse it. */
function digestUnknownCatalog(snapshot: unknown): unknown {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return digestMcpRuntimeCatalog(snapshot as McpConformanceCatalogSnapshot, digestOptions);
}

const duplicateIdentities: [label: string, snapshot: McpConformanceCatalogSnapshot][] = [
	[
		"tools",
		{
			...catalogSnapshot(),
			tools: [
				{ name: "alpha", inputSchema: { type: "object" } },
				{ name: "alpha", inputSchema: { type: "string" } },
			],
		},
	],
	[
		"resources",
		{ ...catalogSnapshot(), resources: [{ uri: "file:///a.txt" }, { uri: "file:///a.txt" }] },
	],
	[
		"resource templates",
		{
			...catalogSnapshot(),
			resourceTemplates: [{ uriTemplate: "file:///{path}" }, { uriTemplate: "file:///{path}" }],
		},
	],
	["prompts", { ...catalogSnapshot(), prompts: [{ name: "draft" }, { name: "draft" }] }],
];

const invalidIdentities: [label: string, name: unknown][] = [
	["an empty name", ""],
	["an untrimmed name", " alpha "],
	["a control character", "al\u0007pha"],
	["a non-NFC name", "e\u0301cho"],
	["an oversized name", "a".repeat(257)],
	["a non-string name", 1],
	["a missing name", undefined],
];

describe("canonical catalog digests", () => {
	it("returns a frozen digest with tools sorted by name", () => {
		const digest = digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions);

		expect(digest.catalogFingerprint).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
		expect(digest.tools.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
		expect(Object.isFrozen(digest)).toBe(true);
		expect(Object.isFrozen(digest.tools)).toBe(true);
		expect(Object.isFrozen(digest.tools[0])).toBe(true);
	});

	it("erases discovery order from every collection", () => {
		const base = catalogSnapshot();
		const shuffled: McpConformanceCatalogSnapshot = {
			prompts: base.prompts.toReversed(),
			resourceTemplates: [...base.resourceTemplates],
			resources: base.resources.toReversed(),
			tools: base.tools.toReversed(),
		};

		expect(digestMcpRuntimeCatalog(shuffled, digestOptions)).toEqual(
			digestMcpRuntimeCatalog(base, digestOptions),
		);
	});

	it("ignores snapshot fields outside the catalog contract", () => {
		const withDiscoveryTime = { ...catalogSnapshot(), discoveredAt: "2026-01-01T00:00:00.000Z" };

		expect(digestUnknownCatalog(withDiscoveryTime)).toEqual(
			digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions),
		);
	});

	it("separates the catalog identity from each tool schema identity", () => {
		const base = digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions);
		const changed = digestMcpRuntimeCatalog(
			{
				...catalogSnapshot(),
				tools: [
					{ name: "beta", inputSchema: { type: "object", properties: { b: { type: "number" } } } },
					{ name: "alpha", inputSchema: { type: "string" } },
				],
			},
			digestOptions,
		);

		expect(changed.catalogFingerprint).not.toBe(base.catalogFingerprint);
		expect(changed.tools[0]?.schemaDigest).not.toBe(base.tools[0]?.schemaDigest);
		expect(changed.tools[1]?.schemaDigest).toBe(base.tools[1]?.schemaDigest);
	});

	it("separates the two caller-supplied domains", () => {
		const base = digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions);
		const rebranded = digestMcpRuntimeCatalog(catalogSnapshot(), {
			domain: "test/mcp/catalog/v2",
			toolSchemaDomain: "test/mcp/tool-schema/v2",
		});

		expect(rebranded.catalogFingerprint).not.toBe(base.catalogFingerprint);
		expect(rebranded.tools[0]?.schemaDigest).not.toBe(base.tools[0]?.schemaDigest);
	});

	it("validates both domains with the fingerprint domain rule", () => {
		expect(() =>
			digestMcpRuntimeCatalog(catalogSnapshot(), {
				domain: "Not A Domain",
				toolSchemaDomain: digestOptions.toolSchemaDomain,
			}),
		).toThrow(/options\.domain/u);
		expect(() =>
			digestMcpRuntimeCatalog(catalogSnapshot(), {
				domain: digestOptions.domain,
				toolSchemaDomain: "Not A Domain",
			}),
		).toThrow(/options\.toolSchemaDomain/u);
	});

	it.each(duplicateIdentities)("refuses duplicate %s identities", (_label, snapshot) => {
		expect(captureFailure(() => digestMcpRuntimeCatalog(snapshot, digestOptions))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
	});

	it.each(invalidIdentities)("refuses %s", (_label, name) => {
		const snapshot = { ...catalogSnapshot(), tools: [{ name, inputSchema: { type: "object" } }] };

		expect(captureFailure(() => digestUnknownCatalog(snapshot))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
	});

	it("refuses a tool without an input schema", () => {
		const snapshot = { ...catalogSnapshot(), tools: [{ name: "alpha" }] };

		expect(captureFailure(() => digestUnknownCatalog(snapshot))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
	});

	it("refuses a snapshot that is not a plain collection of catalog arrays", () => {
		for (const snapshot of [null, "catalog", new Proxy(catalogSnapshot(), {})]) {
			expect(captureFailure(() => digestUnknownCatalog(snapshot))).toBe(
				MCP_CONFORMANCE_CATALOG_REJECTED,
			);
		}
		expect(captureFailure(() => digestUnknownCatalog({ ...catalogSnapshot(), tools: {} }))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
		expect(captureFailure(() => digestUnknownCatalog({ ...catalogSnapshot(), tools: [1] }))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
	});

	it("refuses a catalog collection exposed through an accessor", () => {
		const snapshot = Object.defineProperty({ ...catalogSnapshot() }, "tools", {
			get: () => [],
			enumerable: true,
			configurable: true,
		});

		expect(captureFailure(() => digestUnknownCatalog(snapshot))).toBe(
			MCP_CONFORMANCE_CATALOG_REJECTED,
		);
	});

	it("applies the caller's capture limits before and after the per-array fence", () => {
		expect(
			captureFailure(() =>
				digestMcpRuntimeCatalog(catalogSnapshot(), {
					...digestOptions,
					limits: testLimits({ maxItems: 1 }),
				}),
			),
		).toBe(MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED);

		expect(
			captureFailure(() =>
				digestMcpRuntimeCatalog(catalogSnapshot(), {
					...digestOptions,
					limits: testLimits({ maxItems: 6 }),
				}),
			),
		).toBe(MCP_CONFORMANCE_CATALOG_REJECTED);

		expect(
			digestMcpRuntimeCatalog(catalogSnapshot(), {
				...digestOptions,
				limits: testLimits({ maxItems: 7 }),
			}),
		).toEqual(digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions));
	});
});

describe("hexadecimal fingerprint rendering", () => {
	it("renders a fingerprint as 64 lowercase hexadecimal characters", () => {
		const { catalogFingerprint } = digestMcpRuntimeCatalog(catalogSnapshot(), digestOptions);
		const hex = toMcpConformanceFingerprintHex(catalogFingerprint);

		expect(hex).toMatch(/^[0-9a-f]{64}$/u);
		expect(Buffer.from(hex, "hex").toString("base64url")).toBe(
			catalogFingerprint.slice("sha256:".length),
		);
		expect(toMcpConformanceFingerprintHex(`sha256:${"A".repeat(43)}`)).toBe("0".repeat(64));
		expect(
			toMcpConformanceFingerprintHex(fingerprintMcpConformanceValue({ a: 1 }, "test/v1")),
		).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("rejects text that is not a canonical sha256 conformance fingerprint", () => {
		for (const invalid of [
			"",
			"sha256:",
			`sha512:${"A".repeat(43)}`,
			"A".repeat(43),
			`sha256:${"A".repeat(44)}`,
			`sha256:${"A".repeat(42)}B`,
		]) {
			expect(() => toMcpConformanceFingerprintHex(invalid)).toThrow(TypeError);
		}
	});
});
