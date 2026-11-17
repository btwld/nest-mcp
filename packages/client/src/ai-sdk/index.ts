import { jsonSchema, tool, type Tool } from "ai";

export interface AiSdkMcpToolDescriptor {
	/** Already selected and named by the host. Names must be unique. */
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Parameters<typeof jsonSchema<Record<string, unknown>>>[0];
}
export type AiSdkMcpToolInvocation = (
	name: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
) => unknown;

/** Adapts sanitized descriptors; every execution remains behind the supplied protected delegate. */
export function createAiSdkMcpTools(
	descriptors: readonly AiSdkMcpToolDescriptor[],
	invoke: AiSdkMcpToolInvocation,
): Record<string, Tool<Record<string, unknown>, unknown>> {
	const names = new Set<string>();
	return Object.fromEntries(
		descriptors.map((descriptor) => {
			const { name, description } = descriptor;
			if (name.length === 0 || names.has(name))
				throw new TypeError("MCP tool names must be nonempty and unique.");
			names.add(name);
			const inputSchema = structuredClone(descriptor.inputSchema);
			return [
				name,
				tool({
					// MCP optional fields may be mutually exclusive or distinguish absence from null.
					// Provider strict normalization must not change that source contract.
					strict: false,
					...(description === undefined ? {} : { description }),
					inputSchema: jsonSchema<Record<string, unknown>>(inputSchema),
					execute: async (input, options) => {
						options.abortSignal?.throwIfAborted();
						const result = await invoke(name, input, options.abortSignal);
						options.abortSignal?.throwIfAborted();
						return result;
					},
				}),
			];
		}),
	);
}
