import { Injectable, Scope } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { McpModuleError } from "../mcp.errors.ts";
import { MCP_HANDLER_METADATA, MCP_TARGETS_METADATA } from "../mcp.tokens.ts";
import type { HandlerDefinition } from "../decorators/mcp-handler.decorators.ts";
import { McpHandlerRegistry } from "./mcp-handler.registry.ts";

@Injectable()
export class McpHandlerExplorer {
	#scanned = false;

	constructor(
		private readonly discovery: DiscoveryService,
		private readonly metadataScanner: MetadataScanner,
		private readonly reflector: Reflector,
		private readonly registry: McpHandlerRegistry,
	) {}

	assertSingleRoot(): void {
		const rootCount = this.discovery
			.getProviders()
			.filter(({ token }) => token === McpHandlerRegistry).length;
		if (rootCount === 1) return;
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"McpModule.forRoot() or forRootAsync() must be imported exactly once per Nest application. Configure every inbound MCP server in that shared root and import one McpClientModule when named upstreams are needed.",
		);
	}

	scan(): void {
		if (this.#scanned) return;
		this.#scanned = true;

		for (const wrapper of this.discovery.getProviders()) {
			const metatype = wrapper.metatype;
			if (metatype?.prototype === undefined) continue;
			const classTargets = this.reflector.get<readonly string[]>(MCP_TARGETS_METADATA, metatype);
			for (const methodName of this.metadataScanner.getAllMethodNames(metatype.prototype)) {
				const prototypeMethod: unknown = metatype.prototype[methodName];
				if (typeof prototypeMethod !== "function") continue;
				const definition = this.reflector.get<HandlerDefinition>(
					MCP_HANDLER_METADATA,
					prototypeMethod,
				);
				if (definition === undefined) continue;

				if (
					(wrapper.scope !== undefined && wrapper.scope !== Scope.DEFAULT) ||
					!wrapper.isDependencyTreeStatic()
				) {
					throw new McpModuleError(
						"INVALID_SCOPE",
						`Decorated MCP handler ${metatype.name}.${methodName} must belong to a singleton provider with a static dependency tree.`,
					);
				}
				const instance: unknown = wrapper.instance;
				if (typeof instance !== "object" || instance === null) {
					throw new McpModuleError(
						"INVALID_SCOPE",
						`Decorated MCP handler ${metatype.name}.${methodName} must belong to a singleton provider.`,
					);
				}
				const method: unknown = Reflect.get(instance, methodName);
				if (typeof method !== "function") {
					throw new McpModuleError(
						"INVALID_HANDLER",
						`Decorated MCP handler ${metatype.name}.${methodName} is not callable.`,
					);
				}
				this.registry.register(
					withDefaultTargets(definition, classTargets),
					(...arguments_: unknown[]) => Reflect.apply(method, instance, arguments_),
					`${metatype.name}.${methodName}`,
				);
			}
		}
	}
}

function withDefaultTargets(
	definition: HandlerDefinition,
	classTargets: readonly string[] | undefined,
): HandlerDefinition {
	if (definition.options.servers !== undefined || classTargets === undefined) return definition;
	if (definition.kind === "tool") {
		return Object.freeze({
			kind: "tool",
			options: Object.freeze({ ...definition.options, servers: classTargets }),
		});
	}
	if (definition.kind === "prompt") {
		return Object.freeze({
			kind: "prompt",
			options: Object.freeze({ ...definition.options, servers: classTargets }),
		});
	}
	return Object.freeze({
		kind: "resource",
		options: Object.freeze({ ...definition.options, servers: classTargets }),
	});
}
