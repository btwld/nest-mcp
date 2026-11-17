import type {
	McpCatalogExposurePolicy,
	McpCatalogExposureResolverInput,
	McpCatalogExposureStrategy,
	McpCatalogLazyExposure,
	McpCatalogReadonly,
	McpCatalogSearchExposure,
	McpNestServerDefinition,
	ToolOptions,
} from "../src/index.ts";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type Assert<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type IsEqual<Left, Right> = [Left] extends [Right]
	? [Right] extends [Left]
		? true
		: false
	: false;

const lazyPolicy = {
	resolve: (_input: McpCatalogExposureResolverInput) => ({
		kind: "lazy",
		eager: [{ kind: "tag", tag: "public" }],
	}),
} satisfies McpCatalogExposurePolicy;

const principalPolicy = {
	resolve: (input: McpCatalogExposureResolverInput) =>
		input.principal === undefined
			? { kind: "lazy", eager: [{ kind: "name", name: "anonymous-help" }] }
			: { kind: "eager" },
} satisfies McpCatalogExposurePolicy;

class PrincipalCatalogPolicy implements McpCatalogExposurePolicy {
	resolve = principalPolicy.resolve;
}

export type LazyKindIsPreserved = Assert<
	IsEqual<Awaited<ReturnType<typeof lazyPolicy.resolve>>["kind"], "lazy">
>;
export type ResolverUnionIsPreserved = Assert<
	IsEqual<Awaited<ReturnType<typeof principalPolicy.resolve>>["kind"], "lazy" | "eager">
>;
export type LazyStrategyExtractsExactly = Assert<
	IsEqual<McpCatalogExposureStrategy<"lazy">, McpCatalogLazyExposure>
>;
export type UnknownStrategyIsRejected = AssertFalse<
	IsAssignable<{ readonly kind: "unknown" }, McpCatalogExposureStrategy>
>;
export type CatalogReadonlyRecurses = Assert<
	IsEqual<
		McpCatalogReadonly<{ nested: { values: string[] } }>,
		{ readonly nested: { readonly values: readonly string[] } }
	>
>;

const definition = {
	name: "catalog",
	serverInfo: { name: "catalog", version: "1.0.0" },
	catalogExposure: { policy: PrincipalCatalogPolicy },
} satisfies McpNestServerDefinition;

const taggedOptions = {
	name: "tagged",
	tags: ["public", "stable"] as const,
} satisfies ToolOptions;

void definition;
void taggedOptions;

// @ts-expect-error Search exposure requires explicit vendor deferred metadata.
const missingSearchMetadata: McpCatalogSearchExposure = { kind: "search" };

const readonlyPolicy: McpCatalogExposurePolicy = {
	resolve: (input) => {
		const first = input.tools[0];
		if (first !== undefined) {
			// @ts-expect-error Catalog tags are deeply readonly.
			first.tags.push("mutated");
			// @ts-expect-error Official tool input schemas are deeply readonly.
			first.tool.inputSchema.type = "string";
		}
		return { kind: "eager" };
	},
};

const invalidPolicy: McpCatalogExposurePolicy = {
	// @ts-expect-error Policy types reject undeclared strategy discriminants.
	resolve: () => ({ kind: "unknown" }),
};

const invalidPredicate: McpCatalogLazyExposure = {
	kind: "lazy",
	eager: [
		{
			kind: "predicate",
			// @ts-expect-error Predicate selectors must return boolean decisions.
			predicate: () => "yes",
		},
	],
};

void missingSearchMetadata;
void invalidPredicate;
void invalidPolicy;
void readonlyPolicy;
