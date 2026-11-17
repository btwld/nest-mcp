import { Injectable } from "@nestjs/common";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { McpRuntimeService } from "../mcp-runtime.service.ts";

/**
 * Read access to a server's OAuth authorization-server proxy. Its primary use
 * is retrieving the upstream tokens behind a verified access token — the
 * credential source a gateway needs for user-delegated upstream calls.
 */
@Injectable()
export class McpOAuthService {
	constructor(private readonly runtimeService: McpRuntimeService) {}

	/**
	 * Loads the upstream tokens for the grant referenced by a verified
	 * `AuthInfo` (via its `gid` claim). Returns `undefined` when the server has
	 * no proxy, the token carries no grant id, or the grant has been revoked.
	 */
	async upstreamTokens(
		serverName: string,
		authInfo: Readonly<AuthInfo>,
	): Promise<
		| { readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt?: number }
		| undefined
	> {
		const proxy = this.runtimeService.oauthProxy(serverName);
		if (proxy === undefined) return undefined;
		const grantId = grantIdOf(authInfo);
		if (grantId === undefined) return undefined;
		const upstream = await proxy.loadUpstreamTokens(grantId);
		if (upstream === undefined) return undefined;
		return {
			accessToken: upstream.accessToken,
			...(upstream.refreshToken === undefined ? {} : { refreshToken: upstream.refreshToken }),
			...(upstream.expiresAt === undefined ? {} : { expiresAt: upstream.expiresAt }),
		};
	}
}

function grantIdOf(authInfo: Readonly<AuthInfo>): string | undefined {
	const claims = authInfo.extra?.["claims"];
	if (typeof claims !== "object" || claims === null) return undefined;
	const gid = Reflect.get(claims, "gid");
	return typeof gid === "string" && gid.length > 0 ? gid : undefined;
}
