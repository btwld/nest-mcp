import { fromJsonSchema } from "@nest-mcp/server";
import { z } from "zod/v4";
import { Prompt, Resource, Tool, createMcpHandlerPassthroughMiddleware } from "../src/index.ts";
import type {
	McpHandlerInvocationInput,
	McpHandlerInvocationOutputFor,
	PromptMethodDecorator,
	PromptOptions,
	ReadResourceResult,
	ResourceMethodDecorator,
	ResourceOptions,
	ToolMethodDecorator,
	ToolOptions,
} from "../src/index.ts";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type AssertFalse<Value extends false> = Value;
type ToolInvocation = McpHandlerInvocationInput & { readonly kind: "tool" };
type PublicRuntimeApi = typeof import("../src/index.ts");

/** Proves a resource result cannot cross a tool invocation discriminator. */
export type ToolInvocationRejectsResourceResult = AssertFalse<
	IsAssignable<ReadResourceResult, McpHandlerInvocationOutputFor<ToolInvocation>>
>;

/** Proves the unprefixed capability decorator types are exported by the public barrel. */
export type CapabilityDecoratorApi = {
	readonly options: ToolOptions | PromptOptions | ResourceOptions;
	readonly method:
		| ToolMethodDecorator<undefined>
		| PromptMethodDecorator<undefined>
		| ResourceMethodDecorator<string>;
};

/** Prevents the removed prefixed decorator values from returning to the public API. */
export type LegacyCapabilityDecoratorNamesAreAbsent = [
	AssertFalse<"McpTool" extends keyof PublicRuntimeApi ? true : false>,
	AssertFalse<"McpPrompt" extends keyof PublicRuntimeApi ? true : false>,
	AssertFalse<"McpResource" extends keyof PublicRuntimeApi ? true : false>,
	AssertFalse<"McpTargets" extends keyof PublicRuntimeApi ? true : false>,
];

createMcpHandlerPassthroughMiddleware(async (_operation, next) => {
	await next();
});

// @ts-expect-error Passthrough handler middleware cannot replace the SDK capability result.
createMcpHandlerPassthroughMiddleware(async () => ({ content: [] }));

const inputSchema = fromJsonSchema<{ name: string }>({
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
});
const zodInputSchema = z.object({ count: z.coerce.number() });

class ValidDecoratedHandlers {
	@Tool({ name: "greet", inputSchema })
	greet({ name }: { name: string }) {
		return { content: [{ type: "text" as const, text: name }] };
	}

	@Tool({ name: "count", inputSchema: zodInputSchema })
	count({ count }: z.output<typeof zodInputSchema>) {
		return { content: [{ type: "text" as const, text: String(count) }] };
	}

	@Prompt({ name: "summarize", argsSchema: inputSchema })
	summarize({ name }: { name: string }) {
		return {
			messages: [{ role: "user" as const, content: { type: "text" as const, text: name } }],
		};
	}

	@Resource({ name: "guide", uri: "docs://guide" })
	guide(uri: URL) {
		return { contents: [{ uri: uri.href, text: "guide" }] };
	}
}

class InvalidDecoratedHandlers {
	// @ts-expect-error The schema requires a string-valued name argument.
	@Tool({ name: "invalid", inputSchema })
	invalid({ name }: { name: number }) {
		return { content: [{ type: "text" as const, text: String(name) }] };
	}

	// @ts-expect-error Zod coercion produces a number for the handler.
	@Tool({ name: "invalid-zod", inputSchema: zodInputSchema })
	invalidZod({ count }: { count: string }) {
		return { content: [{ type: "text" as const, text: count }] };
	}
}

void ValidDecoratedHandlers;
void InvalidDecoratedHandlers;
