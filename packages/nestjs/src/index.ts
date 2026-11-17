export { McpModuleError } from "./mcp.errors.ts";
export type { McpModuleErrorCode } from "./mcp.errors.ts";
export type { McpNestCollaborators, McpProviderToken } from "./mcp-provider.types.ts";
export {
	MCP_CATALOG_SCHEMAS_TOOL_NAME,
	MCP_CATALOG_SEARCH_TOOL_NAME,
} from "./mcp-catalog-exposure.ts";
export type {
	McpCatalogEagerExposure,
	McpCatalogExposureKind,
	McpCatalogExposurePolicy,
	McpCatalogExposureResolverInput,
	McpCatalogExposureStrategy,
	McpCatalogLazyExposure,
	McpCatalogNameSelector,
	McpCatalogPredicateSelector,
	McpCatalogReadonly,
	McpCatalogSchemasResult,
	McpCatalogSearchExposure,
	McpCatalogSearchResult,
	McpCatalogSearchResultTool,
	McpCatalogTagSelector,
	McpCatalogTool,
	McpCatalogToolSelector,
} from "./mcp-catalog-exposure.ts";
export { Prompt, Resource, Targets, Tool } from "./decorators/mcp-handler.decorators.ts";
export type {
	PromptMethodDecorator,
	PromptOptions,
	ResourceMethodDecorator,
	ResourceOptions,
	ToolMethodDecorator,
	ToolOptions,
} from "./decorators/mcp-handler.decorators.ts";
export { McpHttpController, McpHttpControllerFor } from "./mcp-http.controller.ts";
export type { McpHttpControllerClass } from "./mcp-http.controller.ts";
export { mcpCorsOptions } from "./mcp-cors.ts";
export type { McpCorsInput, McpNestCorsOptions } from "./mcp-cors.ts";
export { McpOAuthControllerFor, McpOAuthController } from "./oauth/mcp-oauth.controller.ts";
export type { McpOAuthControllerClass } from "./oauth/mcp-oauth.controller.ts";
export { McpOAuthService } from "./oauth/mcp-oauth.service.ts";
export type {
	McpAnonymousAccessPolicy,
	McpNestClientIdMetadataOptions,
	McpNestOAuthMetadataOptions,
	McpNestOAuthProxyOptions,
	McpNestOAuthResourceOptions,
	McpNestServerOAuthOptions,
	McpOAuthConsentProvider,
	McpOAuthFetchProvider,
	McpOAuthSecretProvider,
	McpOAuthSigningKeyProvider,
	McpOAuthSubjectResolverProvider,
	McpOAuthTokenVerifierProvider,
	McpOAuthUpstreamProvider,
} from "./oauth/mcp-oauth.types.ts";
export { McpModule } from "./mcp.module.ts";
export type { McpForRootAsyncOptions, McpForRootOptions } from "./mcp.module-definition.ts";
export { McpClientModule } from "./client/mcp-client.module.ts";
export type {
	McpClientForRootAsyncOptions,
	McpClientForRootOptions,
} from "./client/mcp-client.module-definition.ts";
export { McpClientService } from "./client/mcp-client.service.ts";
export type {
	McpClientAttributesResolverProvider,
	McpClientBootstrapOptions,
	McpClientClock,
	McpClientConfiguratorProvider,
	McpClientFetchMiddlewareProvider,
	McpClientFetchProvider,
	McpClientLifecycleErrorReporter,
	McpClientMiddlewareProvider,
	McpClientModuleExtras,
	McpClientModuleOptions,
	McpClientOperationIdFactory,
	McpClientPrincipalResolverProvider,
	McpClientProgressObserver,
	McpClientReconnectionSchedulerProvider,
	McpNestClientConnectOptions,
	McpNestClientDefinition,
	McpNestClientLifecycleOptions,
	McpNestClientOptions,
	McpNestClientRuntimeOptions,
	McpNestClientTransportDefinition,
	McpNestHttpClientTransportDefinition,
	McpNestStdioClientTransportDefinition,
} from "./client/mcp-client.types.ts";
export { McpCapabilitiesService } from "./mcp-capabilities.service.ts";
export { McpRuntimeService } from "./mcp-runtime.service.ts";
export type { McpHttpRoute, McpHttpDiscoveryRoutes } from "./http/mcp-http-route.types.ts";
export { createMcpHandlerPassthroughMiddleware } from "./mcp-handler.middleware.ts";
export type {
	McpCapabilityMutation,
	McpCapabilityDescriptor,
	McpCapabilityMutationKind,
	McpCapabilityMutationObserver,
	McpCapabilityMutationType,
	McpCapabilityVisibility,
	McpCapabilityVisibilityPolicy,
	McpDynamicHandlerRegistration,
} from "./mcp-capability.types.ts";
export type {
	McpHandlerAuthorizationPolicy,
	McpHandlerInvocationInput,
	McpHandlerInvocationOutput,
	McpHandlerInvocationOutputFor,
	McpHandlerInvocationOutputMap,
	McpHandlerLifecycleObserver,
	McpHandlerMiddleware,
	McpHandlerMiddlewareProvider,
	McpHandlerOperationContext,
	McpHandlerPassthroughMiddleware,
	McpGatewayAuthorizationContextProvider,
	McpGatewayClientProvider,
	McpGatewayDiscoveryCacheProvider,
	McpGatewayLifecycleObserverProvider,
	McpGatewayMiddlewareProvider,
	McpGatewayNameCodecProvider,
	McpGatewayObserverErrorReporter,
	McpGatewayPromptNameCodecProvider,
	McpGatewayResourceTemplateUriCodecProvider,
	McpGatewayResourceUriCodecProvider,
	McpModuleExtras,
	McpModuleOptions,
	McpNestCatalogExposureOptions,
	McpNestGatewayOptions,
	McpNestGatewayProviderUpstream,
	McpNestGatewayUpstream,
	McpNestGatewayUpstreamDefinition,
	McpNestServerDefinition,
	McpServerContributor,
	McpServerErrorReporter,
	McpServerLifecycleObserver,
	McpServerMiddlewareProvider,
	McpServerPrincipalClaimsProvider,
	McpServerRuntimeObserverProvider,
} from "./mcp.types.ts";
export type {
	McpNestServerHttpOptions,
	McpNestServerOptions,
	McpRequestStateVerifier,
} from "./server/mcp-server.types.ts";

export { allowMcpOperation, denyMcpOperation } from "@nest-mcp/core";
export type { McpAuthorizationDecision } from "@nest-mcp/core";

export {
	acceptedContent,
	completable,
	createRequestStateCodec,
	fromJsonSchema,
	inputRequired,
	inputResponse,
	ResourceTemplate,
} from "@nest-mcp/server";
export type {
	CacheHint,
	CallToolResult,
	CompletableSchema,
	CompleteCallback,
	CompleteResourceTemplateCallback,
	ElicitInputParams,
	GetPromptResult,
	Icon,
	InputRequiredSpec,
	InputRequiredResult,
	InputResponseView,
	McpServerBuildContext,
	McpServerMiddleware,
	McpServerPrincipal,
	McpServerPrincipalClaims,
	PromptCallback,
	ReadResourceCallback,
	ReadResourceResult,
	ReadResourceTemplateCallback,
	RequestStateCodec,
	RequestStateCodecOptions,
	ResourceMetadata,
	ServerContext,
	StandardSchemaWithJSON,
	ToolAnnotations,
	ToolCallback,
} from "@nest-mcp/server";
export type {
	McpCorsOptions,
	McpHttpSecurityOptions,
	McpHttpSecurityPolicy,
} from "@nest-mcp/server/security";
