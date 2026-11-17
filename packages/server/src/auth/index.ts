export { McpResourceServer } from "./mcp-resource-server.ts";
export type { McpFetchHandler, McpResourceServerOptions } from "./mcp-resource-server.ts";

export {
	bearerAuthChallengeResponse,
	buildOAuthProtectedResourceMetadata,
	getOAuthProtectedResourceMetadataUrl,
	oauthMetadataResponse,
	requireBearerAuth,
	verifyBearerToken,
} from "@modelcontextprotocol/server";
export type {
	AuthInfo,
	AuthMetadataOptions,
	BearerAuthOptions,
	OAuthMetadata,
	OAuthProtectedResourceMetadata,
	OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
