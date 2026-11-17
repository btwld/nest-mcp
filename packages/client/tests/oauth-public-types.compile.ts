import type {
	AuthProvider,
	FetchLike,
	McpClientOAuthAuthProvider,
	OAuthTokens,
} from "@nest-mcp/client/oauth";
import {
	McpClientOAuthBootstrap,
	McpClientOAuthProtocol,
	McpClientOAuthProtocolError,
	createMcpClientOAuthCredentialRevision,
	createOAuthStateLookupDigest,
	parseMcpClientOAuthBootstrapChallenge,
} from "@nest-mcp/client/oauth";
import {
	McpClientOAuthDynamicRegistration,
	type McpClientOAuthDynamicRegistrationResult,
} from "@nest-mcp/client/oauth/dynamic-registration";

// @ts-expect-error The strict OAuth subpath never exposes the SDK's implicit interactive provider.
import type { OAuthClientProvider } from "@nest-mcp/client/oauth";
// @ts-expect-error The strict OAuth subpath has no full-flow orchestrator or Dynamic Registration.
import { auth, registerClient } from "@nest-mcp/client/oauth";
// @ts-expect-error Legacy DCR requires its explicit compatibility subpath.
import { McpClientOAuthDynamicRegistration as ImplicitDynamicRegistration } from "@nest-mcp/client/oauth";

declare const guardedFetch: FetchLike;

const protocol = new McpClientOAuthProtocol({
	fetch: guardedFetch,
	endpointPolicy() {
		return true;
	},
});

const bootstrap = new McpClientOAuthBootstrap({
	fetch: guardedFetch,
	endpointPolicy() {
		return true;
	},
});
const challenge = parseMcpClientOAuthBootstrapChallenge(
	'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
);
const dynamicRegistration = new McpClientOAuthDynamicRegistration({
	fetch: guardedFetch,
	endpointPolicy() {
		return true;
	},
});
declare const dynamicRegistrationResult: McpClientOAuthDynamicRegistrationResult;

const revision = createMcpClientOAuthCredentialRevision(1);
const digest: string = createOAuthStateLookupDigest("A".repeat(43));
declare const tokens: OAuthTokens;
declare const transportProvider: McpClientOAuthAuthProvider<string, { readonly token: string }>;
const officialMinimalProvider: AuthProvider = transportProvider;

void protocol;
void bootstrap;
void challenge;
void dynamicRegistration;
void dynamicRegistrationResult.client.clientId;
void revision;
void digest;
void tokens.access_token;
void officialMinimalProvider;
void McpClientOAuthProtocolError;

export type StrictSurfaceDoesNotExposeOAuthClientProvider = OAuthClientProvider;
void auth;
void registerClient;
void ImplicitDynamicRegistration;
