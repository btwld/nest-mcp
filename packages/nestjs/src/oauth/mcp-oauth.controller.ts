import { Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { McpOAuthProxy } from "@nest-mcp/auth";
import {
	parsedBodyOf,
	readNodeBodyText,
	toWebRequestWithBody,
	writeWebResponse,
} from "../http/node-bridge.ts";
import { McpModuleError } from "../mcp.errors.ts";
import { McpRuntimeService } from "../mcp-runtime.service.ts";

/** Constructor returned by {@link McpOAuthControllerFor}. */
export type McpOAuthControllerClass = abstract new (
	runtimeService: McpRuntimeService,
) => McpOAuthController;

const MAX_FORM_BODY_BYTES = 65_536;

/**
 * Nest-native host for a server's OAuth authorization-server proxy endpoints.
 * Each route is an explicit method that calls its proxy operation directly —
 * there is no path matching against a base path, so a Nest global prefix,
 * versioning, or a controller path never desynchronizes from the router. The
 * well-known documents must resolve at the origin root, so mount the concrete
 * controller at `@Controller()` and exclude those paths from any global prefix.
 * Requires the server to configure `oauth.proxy`.
 */
export abstract class McpOAuthController {
	constructor(@Inject(McpRuntimeService) private readonly runtimeService: McpRuntimeService) {}

	protected get mcpServerName(): string {
		throw new TypeError(
			"MCP OAuth controller must bind a named server through McpOAuthControllerFor().",
		);
	}

	@Get(".well-known/oauth-authorization-server")
	async authorizationServerMetadata(@Res({ passthrough: true }) response: unknown): Promise<void> {
		await writeWebResponse(jsonResponse(this.#proxy().authorizationServerMetadata), response);
	}

	@Get(".well-known/jwks.json")
	async jwks(@Res({ passthrough: true }) response: unknown): Promise<void> {
		await writeWebResponse(jsonResponse(this.#proxy().jwks()), response);
	}

	@Get(".well-known/oauth-protected-resource")
	async protectedResourceMetadata(@Res({ passthrough: true }) response: unknown): Promise<void> {
		await writeWebResponse(jsonResponse(this.#proxy().protectedResourceMetadata()), response);
	}

	@Get("oauth/authorize")
	async authorize(
		@Req() request: unknown,
		@Res({ passthrough: true }) response: unknown,
	): Promise<void> {
		const webRequest = toWebRequestWithBody(request, undefined);
		await writeWebResponse(await this.#proxy().authorize(webRequest), response);
	}

	@Post("oauth/authorize/consent")
	async consent(
		@Req() request: unknown,
		@Res({ passthrough: true }) response: unknown,
	): Promise<void> {
		const { webRequest, form } = await this.#readForm(request);
		await writeWebResponse(await this.#proxy().handleConsent(webRequest, form), response);
	}

	@Get("oauth/callback")
	async callback(
		@Req() request: unknown,
		@Res({ passthrough: true }) response: unknown,
	): Promise<void> {
		const webRequest = toWebRequestWithBody(request, undefined);
		await writeWebResponse(await this.#proxy().handleCallback(webRequest), response);
	}

	@Post("oauth/token")
	async token(
		@Req() request: unknown,
		@Res({ passthrough: true }) response: unknown,
	): Promise<void> {
		const { webRequest, form } = await this.#readForm(request);
		await writeWebResponse(await this.#proxy().token(webRequest, form), response);
	}

	async #readForm(
		request: unknown,
	): Promise<{ readonly webRequest: Request; readonly form: URLSearchParams }> {
		// The token/consent bodies are form-encoded; read the raw stream (the SDK
		// adapter would otherwise JSON-serialize a platform-parsed body).
		const parsed = parsedBodyOf(request);
		const bodyText =
			parsed === undefined ? await readNodeBodyText(request, MAX_FORM_BODY_BYTES) : undefined;
		const webRequest = toWebRequestWithBody(request, bodyText);
		return { webRequest, form: toSearchParams(parsed, bodyText) };
	}

	#proxy(): McpOAuthProxy {
		const proxy = this.runtimeService.oauthProxy(this.mcpServerName);
		if (proxy === undefined) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP server "${this.mcpServerName}" has no oauth.proxy configured for an OAuth controller.`,
			);
		}
		return proxy;
	}
}

/**
 * Creates an OAuth controller base bound to one named `McpRuntimeService`
 * server whose definition configures `oauth.proxy`.
 *
 * @example
 * ```ts
 * const AuthControllerBase = McpOAuthControllerFor("artifact");
 *
 * @Controller()
 * export class ArtifactOAuthController extends AuthControllerBase {}
 * ```
 */
export function McpOAuthControllerFor(serverName: string): McpOAuthControllerClass {
	if (typeof serverName !== "string" || serverName.trim().length === 0) {
		throw new TypeError("MCP OAuth controller server name must be a non-empty string.");
	}
	abstract class NamedMcpOAuthController extends McpOAuthController {
		protected override get mcpServerName(): string {
			return serverName;
		}
	}
	return NamedMcpOAuthController;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}

function toSearchParams(parsed: unknown, bodyText: string | undefined): URLSearchParams {
	if (parsed instanceof URLSearchParams) return parsed;
	if (typeof parsed === "string") return new URLSearchParams(parsed);
	if (typeof parsed === "object" && parsed !== null) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") params.set(key, value);
			else if (Array.isArray(value)) {
				for (const entry of value) if (typeof entry === "string") params.append(key, entry);
			}
		}
		return params;
	}
	return new URLSearchParams(bodyText ?? "");
}
