import { All, Inject, Req, Res } from "@nestjs/common";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type {
	FetchLikeMcpHandler,
	NodeMcpRequestHandler,
	ToNodeHandlerOptions,
} from "@modelcontextprotocol/node";
import type { McpServerRuntime } from "@nest-mcp/server";
import {
	hardenMcpFetch,
	resolveMcpHttpSecurity,
	withMcpNodeBodyLimit,
} from "@nest-mcp/server/security";
import type { McpHttpSecurityOptions } from "@nest-mcp/server/security";
import {
	forwardValidatedAuth,
	hijackFastifyReply,
	parsedBodyOf,
	toNodeRequest,
	toNodeResponse,
} from "./http/node-bridge.ts";
import { McpRuntimeService } from "./mcp-runtime.service.ts";

/** Constructor returned by {@link McpHttpControllerFor}. */
export type McpHttpControllerClass = abstract new (
	runtimeService: McpRuntimeService,
) => McpHttpController;

/**
 * Nest-native HTTP entry point for a named MCP server runtime.
 *
 * Extend this class through {@link McpHttpControllerFor}, then put `@Controller`
 * and any guards, interceptors, or version metadata on the concrete subclass.
 * The inherited catch-all route deliberately leaves HTTP method semantics to
 * the MCP handler.
 */
export abstract class McpHttpController {
	constructor(@Inject(McpRuntimeService) private readonly runtimeService: McpRuntimeService) {}

	protected get mcpServerName(): string {
		throw new TypeError(
			"MCP HTTP controller must bind a named server through McpHttpControllerFor().",
		);
	}

	#nodeHandler: NodeMcpRequestHandler | undefined;

	@All()
	async handleMcpRequest(
		@Req() request: unknown,
		@Res({ passthrough: true }) response: unknown,
	): Promise<unknown> {
		const intercepted = this.interceptMcpRequest(request, response);
		if (intercepted !== undefined) return intercepted;
		const nodeRequest = toNodeRequest(request);
		const nodeResponse = toNodeResponse(response);
		forwardValidatedAuth(request, nodeRequest);
		hijackFastifyReply(response, nodeResponse);
		await this.#getNodeHandler()(nodeRequest, nodeResponse, parsedBodyOf(request));
		return undefined;
	}

	/**
	 * Optional Nest-native interception seam before the Node/Web adapter takes ownership.
	 * Returning a value short-circuits MCP dispatch and lets Nest serialize that value;
	 * returning `undefined` delegates to the named MCP runtime.
	 */
	protected interceptMcpRequest(_request: unknown, _response: unknown): unknown {
		return undefined;
	}

	/**
	 * Override to compose another fetch-shaped facade around the named runtime.
	 * The default applies any configured `oauth` resource-server protection and
	 * otherwise returns the runtime untouched.
	 */
	protected createMcpHttpHandler(runtime: McpServerRuntime): FetchLikeMcpHandler {
		return this.runtimeService.composeHttpHandler(this.mcpServerName, runtime);
	}

	/** Override to observe conversion-layer failures handled as HTTP 500 responses. */
	protected getNodeAdapterOptions(): Readonly<ToNodeHandlerOptions> | undefined {
		return undefined;
	}

	/**
	 * Override to replace the runtime's configured HTTP security posture for
	 * this route. The posture is enforced outside `createMcpHttpHandler()`
	 * composition, so a rejected request never reaches a composed facade.
	 */
	protected getHttpSecurityOptions(): McpHttpSecurityOptions | undefined {
		return undefined;
	}

	#getNodeHandler(): NodeMcpRequestHandler {
		if (this.#nodeHandler === undefined) {
			const runtime = this.runtimeService.server(this.mcpServerName);
			const override = this.getHttpSecurityOptions();
			const policy =
				override === undefined ? runtime.httpSecurity : resolveMcpHttpSecurity(override);
			// Rejections detected outside the runtime still surface as observer events.
			const hooks = { onRejected: (status: number) => runtime.reportRequestRejected(status) };
			this.#nodeHandler = withMcpNodeBodyLimit(
				toNodeHandler(
					hardenMcpFetch(this.createMcpHttpHandler(runtime), policy, hooks),
					this.getNodeAdapterOptions(),
				),
				policy,
				hooks,
			);
		}
		return this.#nodeHandler;
	}
}

/**
 * Creates a controller base bound to one named `McpRuntimeService` server.
 *
 * @example
 * ```ts
 * const ArtifactMcpControllerBase = McpHttpControllerFor("artifact");
 *
 * @Controller({ path: "mcp", version: "1" })
 * @UseGuards(ArtifactGuard)
 * export class ArtifactMcpController extends ArtifactMcpControllerBase {}
 * ```
 *
 * Override `createMcpHttpHandler()` or `getNodeAdapterOptions()` on the concrete
 * controller when composition requires additional Nest-injected providers.
 */
export function McpHttpControllerFor(serverName: string): McpHttpControllerClass {
	if (typeof serverName !== "string" || serverName.trim().length === 0) {
		throw new TypeError("MCP HTTP controller server name must be a non-empty string.");
	}

	abstract class NamedMcpHttpController extends McpHttpController {
		protected override get mcpServerName(): string {
			return serverName;
		}
	}

	return NamedMcpHttpController;
}
