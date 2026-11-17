import { describe, expect, it, vi } from "vitest";

import {
	MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS,
	degradedMcpToolResult,
	projectMcpToolResult,
	resolveMcpToolResultProjectionLimits,
} from "../src/index.ts";

const limits = MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS;

describe("MCP tool-result projection", () => {
	it("resolves conservative immutable defaults and rejects unbounded policies", () => {
		expect(resolveMcpToolResultProjectionLimits(undefined)).toEqual(limits);
		expect(Object.isFrozen(resolveMcpToolResultProjectionLimits(undefined))).toBe(true);
		expect(() =>
			resolveMcpToolResultProjectionLimits({ maxStructuredNodes: Number.MAX_SAFE_INTEGER }),
		).toThrow(/maxStructuredNodes/u);
	});

	it("keeps text in wire order under per-block and shared UTF-8 budgets", () => {
		const perBlock = limits.maxTextBytesPerBlock;
		const blockCount = Math.floor(limits.maxTextBytesTotal / perBlock) + 2;
		const source = Array.from({ length: blockCount }, (_, index) => ({
			type: "text",
			text: index === 0 ? "\u{1f600}".repeat(perBlock) : "x".repeat(perBlock),
		}));

		const projected = projectMcpToolResult({ content: source });

		expect(projected.content).toHaveLength(blockCount);
		expect(projected.truncated).toBe(true);
		const total = projected.content.reduce(
			(bytes, block) => bytes + (block.kind === "text" ? Buffer.byteLength(block.text, "utf8") : 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(limits.maxTextBytesTotal);
		const first = projected.content[0];
		if (first?.kind !== "text") throw new Error("expected text");
		expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(perBlock);
		expect(JSON.parse(JSON.stringify(first.text))).toBe(first.text);
		const last = projected.content.at(-1);
		if (last?.kind !== "text") throw new Error("expected text");
		expect(last.text).toBe("");
		expect(last.truncated).toBe(true);
	});

	it("preserves fitted Unicode and lone-surrogate code units with exact UTF-8 budgets", () => {
		for (const text of ["", "ascii", "é雪😀", "\ud800x\udfff", '\n"\\']) {
			const bytes = Buffer.byteLength(text, "utf8");
			const projected = projectMcpToolResult(
				{ content: [{ type: "text", text }], structuredContent: { text } },
				{ maxTextBytesPerBlock: Math.max(1, bytes), maxTextBytesTotal: Math.max(1, bytes) },
			);
			expect(projected.content).toEqual([{ kind: "text", text, truncated: false }]);
			expect(projected.structuredContent).toEqual({ text });
			expect(projected.truncated).toBe(false);
		}
	});

	it("retains complete code points when a short UTF-16 value exceeds its byte budget", () => {
		for (const [text, budget, retained] of [
			["雪雪", 5, "雪"],
			["😀x", 3, ""],
			["éé", 3, "é"],
			["\ud800x", 3, "\ud800"],
		] as const) {
			const projected = projectMcpToolResult(
				{ content: [{ type: "text", text }] },
				{ maxTextBytesPerBlock: budget },
			);
			expect(projected.content).toEqual([{ kind: "text", text: retained, truncated: true }]);
		}
	});

	it("rejects oversized serialized Unicode without changing structured bounds", () => {
		const structuredContent = { text: "雪😀\ud800\n" };
		const bytes = Buffer.byteLength(JSON.stringify(structuredContent), "utf8");
		const exact = projectMcpToolResult(
			{ content: [], structuredContent },
			{ maxStructuredSerializedBytes: bytes },
		);
		const below = projectMcpToolResult(
			{ content: [], structuredContent },
			{ maxStructuredSerializedBytes: bytes - 1 },
		);
		expect(exact.structuredContent).toEqual(structuredContent);
		expect(exact.truncated).toBe(false);
		expect(below.structuredContent).toBeUndefined();
		expect(below.truncated).toBe(true);
	});

	it("summarizes non-text blocks without carrying data, URIs, or future fields", () => {
		const projected = projectMcpToolResult({
			content: [
				{
					type: "image",
					data: "aGVsbG8gd29ybGQh",
					mimeType: "image/png",
					uri: "https://secret.example/private",
				},
				{ type: "future", secret: "never-copy-this" },
			],
		});

		expect(projected.content).toEqual([
			{ kind: "summary", contentType: "image", mediaType: "image/png", bytes: 12 },
			{ kind: "summary", contentType: "future" },
		]);
		expect(projected.truncated).toBe(true);
		expect(JSON.stringify(projected)).not.toContain("secret.example");
		expect(JSON.stringify(projected)).not.toContain("aGVsbG8");
		expect(JSON.stringify(projected)).not.toContain("never-copy-this");
	});

	it("copies structured content into frozen null-prototype bounded JSON", () => {
		let deep: unknown = "leaf";
		for (let index = 0; index < limits.maxStructuredDepth + 2; index += 1) {
			deep = { nested: deep };
		}
		const projected = projectMcpToolResult({
			content: [],
			structuredContent: {
				deep,
				long: "x".repeat(limits.maxStructuredStringBytes + 64),
			},
		});

		expect(projected.truncated).toBe(true);
		if (typeof projected.structuredContent !== "object" || projected.structuredContent === null) {
			throw new Error("expected projected structured content");
		}
		expect(Object.getPrototypeOf(projected.structuredContent)).toBeNull();
		expect(Object.isFrozen(projected.structuredContent)).toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(projected.structuredContent), "utf8"),
		).toBeLessThanOrEqual(limits.maxStructuredSerializedBytes);
	});

	it("drops __proto__, accessors, proxies, cycles, symbols, and exotic values without invoking them", () => {
		const getter = vi.fn(() => "secret");
		const nested: Record<PropertyKey, unknown> = { kept: 1 };
		Object.defineProperty(nested, "__proto__", {
			enumerable: true,
			value: { polluted: true },
		});
		const structured: Record<PropertyKey, unknown> = { safe: nested };
		Object.defineProperty(structured, "accessor", { enumerable: true, get: getter });
		structured.proxy = new Proxy({ secret: true }, {});
		structured.date = new Date();
		structured.cycle = structured;
		structured[Symbol("secret")] = "hidden";

		const projected = projectMcpToolResult({ content: [], structuredContent: structured });
		const serialized = JSON.stringify(projected.structuredContent);

		expect(getter).not.toHaveBeenCalled();
		expect(serialized).toContain('"kept":1');
		expect(serialized).not.toContain("__proto__");
		expect(serialized).not.toContain("polluted");
		expect(serialized).not.toContain("secret");
		expect(projected.truncated).toBe(true);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("drops a bounded key that truncates into __proto__", () => {
		const structured = {
			__proto__x: { polluted: true },
		};

		const projected = projectMcpToolResult(
			{ content: [], structuredContent: structured },
			{ maxStructuredStringBytes: Buffer.byteLength("__proto__", "utf8") },
		);

		expect(projected.truncated).toBe(true);
		expect(projected.structuredContent).toEqual({});
		expect(Object.getPrototypeOf(projected.structuredContent)).toBeNull();
		const downstream = Object.assign({}, projected.structuredContent);
		expect(Object.getPrototypeOf(downstream)).toBe(Object.prototype);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("reports malformed text and isError fields as incomplete", () => {
		for (const text of [null, undefined, 42]) {
			const projected = projectMcpToolResult({ content: [{ type: "text", text }] });
			expect(projected.content).toEqual([{ kind: "text", text: "", truncated: true }]);
			expect(projected.truncated).toBe(true);
		}

		for (const isError of [null, undefined, 0, "false"]) {
			expect(projectMcpToolResult({ content: [], isError }).truncated).toBe(true);
		}
		expect(projectMcpToolResult({ content: [], isError: false }).truncated).toBe(false);

		const normalizedType = projectMcpToolResult({
			content: [{ type: "te\0xt", text: "kept" }],
		});
		expect(normalizedType.content).toEqual([{ kind: "text", text: "kept", truncated: false }]);
		expect(normalizedType.truncated).toBe(true);
		expect(projectMcpToolResult({ content: [], structuredContent: undefined }).truncated).toBe(
			true,
		);
	});

	it("does not split descriptor surrogate pairs or retain lone surrogates", () => {
		const splitPair = projectMcpToolResult(
			{ content: [{ type: "\u{1f600}" }] },
			{ maxSummaryDescriptorLength: 1 },
		);
		const loneSurrogate = projectMcpToolResult({ content: [{ type: "te\ud800xt", text: "x" }] });

		expect(splitPair.content).toEqual([{ kind: "summary", contentType: "unknown" }]);
		expect(splitPair.truncated).toBe(true);
		expect(loneSurrogate.content).toEqual([{ kind: "text", text: "x", truncated: false }]);
		expect(loneSurrogate.truncated).toBe(true);
		expect(JSON.stringify(loneSurrogate)).not.toContain("\\ud800");
	});

	it("reports ignored enumerable string properties on content and structured arrays", () => {
		const extraContent = [{ type: "text", text: "ok" }];
		Object.assign(extraContent, { extra: "ignored" });
		const extraStructured: unknown[] & { extra?: string } = [1];
		extraStructured.extra = "ignored";

		expect(projectMcpToolResult({ content: extraContent }).truncated).toBe(true);
		expect(
			projectMcpToolResult({ content: [], structuredContent: extraStructured }).truncated,
		).toBe(true);
	});

	it("ignores symbol and non-enumerable state outside the MCP JSON surface", () => {
		const getter = vi.fn(() => "ignored");
		const symbolContent = [{ type: "text", text: "ok" }];
		Object.defineProperty(symbolContent, Symbol("ignored"), {
			enumerable: true,
			value: "ignored",
		});
		Object.defineProperty(symbolContent, "hidden", {
			get: getter,
		});
		const symbolStructured = [1];
		Object.defineProperty(symbolStructured, Symbol("ignored"), {
			enumerable: true,
			value: "ignored",
		});
		Object.defineProperty(symbolStructured, "hidden", {
			get: getter,
		});
		const hiddenObject = {};
		Object.defineProperty(hiddenObject, "hidden", {
			get: getter,
		});

		const getOwnPropertySymbols = vi
			.spyOn(Object, "getOwnPropertySymbols")
			.mockImplementation(() => {
				throw new Error("symbol-key materialization is forbidden");
			});
		const projectedContent = projectMcpToolResult({ content: symbolContent });
		const projectedArray = projectMcpToolResult({
			content: [],
			structuredContent: symbolStructured,
		});
		const projectedObject = projectMcpToolResult({
			content: [],
			structuredContent: hiddenObject,
		});
		getOwnPropertySymbols.mockRestore();

		expect(projectedContent.truncated).toBe(false);
		expect(projectedArray.truncated).toBe(false);
		expect(projectedObject.truncated).toBe(false);
		expect(JSON.stringify({ projectedArray, projectedContent, projectedObject })).not.toContain(
			"ignored",
		);
		expect(getter).not.toHaveBeenCalled();
	});

	it("does not use whole-source UTF-8, descriptor, or own-key materialization", () => {
		const hugeText = "x".repeat(limits.maxTextBytesPerBlock * 1_024);
		const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
			throw new Error("whole-source UTF-8 encoding is forbidden");
		});
		const projectedText = projectMcpToolResult({
			content: [{ type: "text", text: hugeText }],
		});
		encode.mockRestore();

		const hugeDescriptor = "image".repeat(limits.maxSummaryDescriptorLength * 8_192);
		const replaceAll = vi.spyOn(String.prototype, "replaceAll").mockImplementation(() => {
			throw new Error("whole-source descriptor replacement is forbidden");
		});
		const projectedDescriptor = projectMcpToolResult({
			content: [{ type: hugeDescriptor }],
		});
		replaceAll.mockRestore();

		const ownKeys = vi.spyOn(Reflect, "ownKeys").mockImplementation(() => {
			throw new Error("whole-source own-key materialization is forbidden");
		});
		const projectedObject = projectMcpToolResult({
			content: [],
			structuredContent: { kept: true },
		});
		ownKeys.mockRestore();

		const text = projectedText.content[0];
		if (text?.kind !== "text") throw new Error("expected projected text");
		expect(Buffer.byteLength(text.text, "utf8")).toBe(limits.maxTextBytesPerBlock);
		expect(text.truncated).toBe(true);
		expect(projectedDescriptor.content).toHaveLength(1);
		expect(projectedObject.structuredContent).toEqual({ kept: true });
	});

	it("rebuilds fitted and truncated strings without retaining source slices", () => {
		const hostileParent = `discard-${"p".repeat(limits.maxStructuredStringBytes * 64)}`;
		const fittedText = hostileParent.slice(8, 8 + 2_048);
		const fittedStructured = hostileParent.slice(16, 16 + 4_096);
		const truncatedText = "t".repeat(limits.maxTextBytesPerBlock * 2);
		const truncatedStructured = "s".repeat(limits.maxStructuredStringBytes * 2);
		const slice = vi.spyOn(String.prototype, "slice").mockImplementation(() => {
			throw new Error("a retained substring view is forbidden");
		});
		const fromCodePoint = vi.spyOn(String, "fromCodePoint");
		const projected = projectMcpToolResult({
			content: [
				{ type: "text", text: fittedText },
				{ type: "text", text: truncatedText },
			],
			structuredContent: {
				fitted: fittedStructured,
				truncated: truncatedStructured,
			},
		});
		const copiedCodePoints = fromCodePoint.mock.calls.length;
		fromCodePoint.mockRestore();
		slice.mockRestore();

		expect(copiedCodePoints).toBeGreaterThan(fittedText.length + fittedStructured.length);
		expect(projected.truncated).toBe(true);
		expect(projected.content).toHaveLength(2);
		const first = projected.content[0];
		const second = projected.content[1];
		if (first?.kind !== "text" || second?.kind !== "text") {
			throw new Error("expected projected text blocks");
		}
		expect(first).toEqual({ kind: "text", text: fittedText, truncated: false });
		expect(Buffer.byteLength(second.text, "utf8")).toBe(limits.maxTextBytesPerBlock);
		expect(second.truncated).toBe(true);
		expect(projected.structuredContent).toEqual({
			fitted: fittedStructured,
			truncated: "s".repeat(limits.maxStructuredStringBytes),
		});
	});

	it("bounds sparse arrays by retained nodes instead of walking their declared length", () => {
		const sparse: unknown[] = [];
		sparse.length = 1_000_000_000;
		sparse[0] = "kept";
		const projected = projectMcpToolResult(
			{ content: [], structuredContent: sparse },
			{ maxStructuredNodes: 4 },
		);

		expect(projected.truncated).toBe(true);
		if (!Array.isArray(projected.structuredContent)) {
			throw new Error("expected projected array");
		}
		expect(projected.structuredContent.length).toBeLessThanOrEqual(3);
	});

	it("never reads source accessors at the result or block boundary", () => {
		const rootContent = vi.fn(() => []);
		const blockData = vi.fn(() => "secret");
		const root = {};
		Object.defineProperty(root, "content", { enumerable: true, get: rootContent });
		const block = { type: "image" };
		Object.defineProperty(block, "data", { enumerable: true, get: blockData });

		const rejectedRoot = projectMcpToolResult(root);
		const rejectedBlock = projectMcpToolResult({ content: [block] });

		expect(rootContent).not.toHaveBeenCalled();
		expect(blockData).not.toHaveBeenCalled();
		expect(rejectedRoot.truncated).toBe(true);
		expect(rejectedBlock.content).toEqual([{ kind: "summary", contentType: "image" }]);
	});

	it("returns an immutable literal degradation when the root cannot be inspected", () => {
		const projected = projectMcpToolResult(new Proxy({}, {}));
		const degraded = degradedMcpToolResult({ isError: true });

		expect(projected).toEqual({ content: [], isError: false, truncated: true });
		expect(degraded).toEqual({ content: [], isError: true, truncated: true });
		expect(Object.isFrozen(projected)).toBe(true);
		expect(Object.isFrozen(projected.content)).toBe(true);
	});
});
