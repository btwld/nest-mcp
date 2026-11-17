import {
	Scope,
	type DynamicModule,
	type OnApplicationBootstrap,
	type Provider,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { McpModuleError } from "./mcp.errors.ts";
import type { McpNestCollaborators } from "./mcp-provider.types.ts";

export type McpRuntimeProviderToken = string | symbol | Function;

export interface McpCollaboratorEntry {
	readonly alias: symbol;
	readonly token: McpRuntimeProviderToken;
}

/** Module-local snapshot of collaborators resolved by Nest through explicit aliases. */
export class McpProviderRegistry {
	readonly #providers: ReadonlyMap<McpRuntimeProviderToken, unknown>;

	constructor(entries: readonly (readonly [McpRuntimeProviderToken, unknown])[]) {
		this.#providers = new Map(entries);
	}

	get(token: unknown): unknown {
		return isMcpRuntimeProviderToken(token) ? this.#providers.get(token) : undefined;
	}
}

/** Fails bootstrap when a configured collaborator has a non-static dependency tree. */
export class McpProviderScopeGuard implements OnApplicationBootstrap {
	constructor(
		private readonly moduleRef: ModuleRef,
		private readonly entries: readonly McpCollaboratorEntry[],
	) {}

	onApplicationBootstrap(): void {
		for (const { alias, token } of this.entries) {
			if (this.moduleRef.introspect(alias).scope === Scope.DEFAULT) continue;
			throw new McpModuleError(
				"INVALID_SCOPE",
				`MCP collaborator ${mcpProviderTokenName(token)} must use the default singleton scope with a static dependency tree.`,
			);
		}
	}
}

/** Adds module-local collaborator providers, aliases, resolution, and scope validation. */
export function withMcpCollaborators(
	definition: DynamicModule,
	collaborators: McpNestCollaborators | undefined,
): DynamicModule {
	const collaboratorProviders = [...(collaborators?.providers ?? [])];
	const entries = collaboratorEntries(collaboratorProviders);
	const aliasProviders = entries.map(({ alias, token }) => ({
		provide: alias,
		useExisting: token,
	}));
	const scopeGuardToken = Symbol("@nest-mcp/nestjs:collaborator-scope-guard");
	return {
		...definition,
		imports: uniqueImports(definition.imports, collaborators?.imports),
		providers: [
			...(definition.providers ?? []),
			...collaboratorProviders,
			...aliasProviders,
			{
				provide: McpProviderRegistry,
				inject: entries.map(({ alias }) => alias),
				useFactory: (...instances: unknown[]) =>
					new McpProviderRegistry(
						entries.map(({ token }, index) => [token, instances[index]] as const),
					),
			},
			{
				provide: scopeGuardToken,
				inject: [ModuleRef],
				useFactory: (moduleRef: ModuleRef) => new McpProviderScopeGuard(moduleRef, entries),
			},
		],
	};
}

function collaboratorEntries(providers: readonly Provider[]): readonly McpCollaboratorEntry[] {
	const seen = new Set<McpRuntimeProviderToken>();
	return providers.map((provider, index) => {
		const token = collaboratorProviderToken(provider);
		if (seen.has(token)) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP collaborators contain duplicate provider token ${mcpProviderTokenName(token)}.`,
			);
		}
		seen.add(token);
		return Object.freeze({
			alias: Symbol(`@nest-mcp/nestjs:collaborator:${String(index)}`),
			token,
		});
	});
}

function collaboratorProviderToken(provider: Provider): McpRuntimeProviderToken {
	const token =
		typeof provider === "function"
			? provider
			: typeof provider === "object" && provider !== null && "provide" in provider
				? provider.provide
				: undefined;
	if (!isMcpRuntimeProviderToken(token)) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP collaborator provider uses unsupported token ${mcpProviderTokenName(token)}.`,
		);
	}
	return token;
}

function uniqueImports(
	...groups: readonly (DynamicModule["imports"] | undefined)[]
): NonNullable<DynamicModule["imports"]> {
	return [...new Set(groups.flatMap((group) => group ?? []))];
}

export function isMcpRuntimeProviderToken(value: unknown): value is McpRuntimeProviderToken {
	return typeof value === "string" || typeof value === "symbol" || typeof value === "function";
}

export function mcpProviderTokenName(token: unknown): string {
	if (typeof token === "string") return JSON.stringify(token);
	if (typeof token === "symbol") return token.description ?? token.toString();
	if (typeof token === "function") return token.name || "<anonymous>";
	return `<invalid ${token === null ? "null" : typeof token}>`;
}
