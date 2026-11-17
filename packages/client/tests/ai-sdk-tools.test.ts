import { describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAiSdkMcpTools } from "../src/ai-sdk/index.ts";

const descriptor = {
	name: "lookup",
	description: "Lookup an entry",
	inputSchema: { type: "object" as const, properties: { query: { type: "string" as const } } },
};
describe("AI SDK MCP tool adapter", () => {
	it("opts out of provider strict normalization without changing optional query fields", async () => {
		const inputSchema = {
			type: "object" as const,
			properties: {
				dataset: { type: "string" as const },
				fields: { type: "array" as const, items: { type: "string" as const } },
				measures: { type: "array" as const, items: { type: "string" as const } },
				group_by: {
					type: "array" as const,
					items: {
						type: "object" as const,
						properties: {
							field: { type: "string" as const },
							interval: { type: "string" as const, enum: ["day", "month"] },
						},
						required: ["field"],
					},
				},
			},
			required: ["dataset"],
		};
		const tools = createAiSdkMcpTools([{ name: "query", inputSchema }], vi.fn());
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("End of unpaid schema probe");
			},
		});
		await expect(generateText({ model, prompt: "Inspect", tools, maxRetries: 0 })).rejects.toThrow(
			"End of unpaid schema probe",
		);
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(model.doGenerateCalls[0]!.tools).toEqual([
			expect.objectContaining({ name: "query", strict: false, inputSchema }),
		]);
		expect(inputSchema.required).toEqual(["dataset"]);
		expect(inputSchema.properties.group_by.items.required).toEqual(["field"]);
	});
	it("preserves omitted versus empty fields and the protected delegate's exclusive query modes", async () => {
		const invoke = vi.fn(async (_name: string, input: Record<string, unknown>) => {
			if (Object.hasOwn(input, "fields") && Object.hasOwn(input, "measures"))
				throw new Error("Fields and measures are mutually exclusive");
			return input;
		});
		const tools = createAiSdkMcpTools([descriptor], invoke);
		const options = { toolCallId: "query", context: {}, messages: [] };
		const aggregate = { measures: ["count"] };
		expect(await tools.lookup!.execute!(aggregate, options)).toBe(aggregate);
		expect(invoke).toHaveBeenLastCalledWith("lookup", aggregate, undefined);
		const invalid = { fields: [], measures: ["count"] };
		await expect(tools.lookup!.execute!(invalid, options)).rejects.toThrow("mutually exclusive");
		expect(invoke).toHaveBeenLastCalledWith("lookup", invalid, undefined);
		const detail = { fields: ["id"] };
		expect(await tools.lookup!.execute!(detail, options)).toBe(detail);
		expect(invoke).toHaveBeenCalledTimes(3);
	});
	it("delegates the exact name, input and cancellation signal without selecting a runtime", async () => {
		const invoke = vi.fn(async () => ({ content: "found" }));
		const tools = createAiSdkMcpTools([descriptor], invoke);
		const controller = new AbortController();
		const input = { query: "entry" };
		const result = await tools.lookup!.execute!(input, {
			abortSignal: controller.signal,
			toolCallId: "one",
			context: {},
			messages: [],
		});
		expect(result).toEqual({ content: "found" });
		expect(invoke).toHaveBeenCalledWith("lookup", input, controller.signal);
		expect(tools.lookup!.description).toBe(descriptor.description);
	});
	it("rejects duplicate names and safely supports object-property names", () => {
		expect(() => createAiSdkMcpTools([descriptor, descriptor], vi.fn())).toThrow(/unique/u);
		const tools = createAiSdkMcpTools([{ ...descriptor, name: "__proto__" }], vi.fn());
		expect(Object.hasOwn(tools, "__proto__")).toBe(true);
	});
	it("captures descriptors and blocks cancelled invocation and late delivery", async () => {
		const mutable = structuredClone(descriptor);
		const controller = new AbortController();
		const invoke = vi.fn(async () => {
			controller.abort();
			return "late";
		});
		const tools = createAiSdkMcpTools([mutable], invoke);
		mutable.name = "another";
		await expect(
			tools.lookup!.execute!(
				{},
				{ abortSignal: controller.signal, toolCallId: "one", context: {}, messages: [] },
			),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledWith("lookup", {}, controller.signal);
		await expect(
			tools.lookup!.execute!(
				{},
				{ abortSignal: controller.signal, toolCallId: "two", context: {}, messages: [] },
			),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledOnce();
	});
});
