# @nest-mcp/server

Framework-neutral MCP v2 server runtime built on the official `@modelcontextprotocol/server`
2.x SDK. Install Zod 4.2 or newer alongside it when using the recommended schema authoring style
below.

## Install

```sh
pnpm add @nest-mcp/server@alpha @modelcontextprotocol/node@2 @modelcontextprotocol/server@2 zod@^4.4.3
```

```ts
import { McpServerRuntime } from "@nest-mcp/server";
import { z } from "zod/v4";

const artifactReadInput = z.object({ id: z.string() });

const runtime = new McpServerRuntime({
	name: "artifact-tools",
	serverInfo: { name: "artifact-tools", version: "1.0.0" },
	features: [
		(server) => {
			server.registerTool("artifact.read", { inputSchema: artifactReadInput }, async ({ id }) => ({
				content: [{ type: "text", text: id }],
			}));
		},
	],
});

// Web-standard hosting:
export default { fetch: (request: Request) => runtime.fetch(request) };

// Node/Nest/Express/Fastify hosting:
const nodeHandler = runtime.toNodeHandler();
```

`createMcpHandler` creates a fresh official SDK server per HTTP request, matching MCP
`2026-07-28`'s stateless model. Features should register capabilities cheaply and close over
long-lived pools rather than create them per request.

`serveStdio()` returns a connection handle owned by the runtime. Closing the handle removes it
from runtime ownership; closing the runtime or its registry closes every still-active stdio
connection before shutdown resolves.

Shutdown rejects new work, closes official HTTP/stdio handlers, and waits for requests or server
builds already accepted by the wrapper. `shutdownTimeoutMs` bounds the complete close and
quiescence phase (30 seconds by
default); expiration is reported as a cleanup failure rather than allowing `close()` to claim a
clean shutdown while application middleware is still running.

`onError` may return a promise. Reporter throws and rejections are observed and isolated so a
logging or telemetry outage never changes protocol results or becomes an unhandled rejection.

The `@nest-mcp/server/auth` subpath adds fail-closed bearer-token verification and optional RFC
9728/RFC 8414 metadata. It treats the MCP server as an OAuth resource server; use a dedicated
identity provider to issue tokens.

## HTTP security posture

Every runtime gates HTTP dispatch through `definition.httpSecurity` before middleware and the SDK
handler run. The defaults are safe without configuration: browser requests from routable origins
are rejected (requests without an `Origin` header always pass), CORS answers the preflights the
2026-07-28 revision requires for `Mcp-Method`/`Mcp-Name` and tool-defined `Mcp-Param-*` headers, and request bodies are capped at 1 MiB on
both the Node stream and the fetch layer.

```ts
const runtime = new McpServerRuntime({
	name: "artifact",
	serverInfo: { name: "artifact", version: "1.0.0" },
	httpSecurity: {
		allowedOriginHostnames: ["app.example.com"],
		cors: { additionalAllowedHeaders: ["x-tenant"] },
		maxBodyBytes: 262_144,
	},
});
```

Pre-dispatch rejections surface to the runtime observer as `request:rejected` events with the HTTP
status. `@nest-mcp/server/security` also exports the building blocks (`resolveMcpHttpSecurity`,
`hardenMcpFetch`, `McpHardenedServer`, `withMcpNodeBodyLimit`) for hand-wired compositions; an
outer hardened facade owns the posture for requests it admits, and the runtime's inner gate defers
to it.

## Multi-round input

The package re-exports the official v2 `inputRequired`, `acceptedContent`, and `inputResponse`
helpers. A tool, prompt, or resource callback can return `inputRequired(...)`; an official modern
client fulfils the embedded elicitation and retries the original operation. Nest-decorated
callbacks use the same official server context and require no separate transport machinery.

If a flow carries facts across rounds, treat `requestState` as attacker-controlled. Configure the
official signed codec on the server and bind it to every authorization dimension that matters:

```ts
import {
	acceptedContent,
	createRequestStateCodec,
	fromJsonSchema,
	inputRequired,
	McpServerRuntime,
} from "@nest-mcp/server";

const confirmationSchema = fromJsonSchema<{ confirm: boolean }>({
	type: "object",
	properties: { confirm: { type: "boolean" } },
	required: ["confirm"],
});
const titleSchema = fromJsonSchema<{ title: string }>({
	type: "object",
	properties: { title: { type: "string" } },
	required: ["title"],
});
const emptySchema = fromJsonSchema<Record<string, never>>({
	type: "object",
	properties: {},
	additionalProperties: false,
});

const stateCodec = createRequestStateCodec<{ step: "confirmed" }>({
	key: requestStateSigningKey, // At least 32 bytes; shared by every runtime replica.
	ttlSeconds: 300,
	// authorizationContext returns the stable tenant + end-user identity for this request.
	bind: (context) => `${context.mcpReq.method}\0${authorizationContext(context)}`,
});

const runtime = new McpServerRuntime({
	name: "artifact-tools",
	serverInfo: { name: "artifact-tools", version: "1.0.0" },
	serverOptions: {
		requestState: { verify: (state, context) => stateCodec.verify(state, context) },
	},
	features: [
		(server) => {
			server.registerTool("publish", { inputSchema: emptySchema }, async (_arguments, context) => {
				const state = context.mcpReq.requestState<{ step: "confirmed" }>();
				if (state?.step !== "confirmed") {
					const confirmation = acceptedContent(
						context.mcpReq.inputResponses,
						"confirm",
						confirmationSchema,
					);
					if (confirmation?.confirm !== true) {
						return inputRequired({
							inputRequests: {
								confirm: inputRequired.elicit({
									message: "Publish this artifact?",
									requestedSchema: confirmationSchema,
								}),
							},
						});
					}
					return inputRequired({
						inputRequests: {
							title: inputRequired.elicit({
								message: "Artifact title?",
								requestedSchema: titleSchema,
							}),
						},
						// Mint the claim only after the confirmation above was validated.
						requestState: await stateCodec.mint({ step: "confirmed" }, context),
					});
				}
				const title = acceptedContent(context.mcpReq.inputResponses, "title", titleSchema);
				if (title === undefined) {
					return inputRequired({
						inputRequests: {
							title: inputRequired.elicit({
								message: "Artifact title?",
								requestedSchema: titleSchema,
							}),
						},
						requestState: await stateCodec.mint({ step: "confirmed" }, context),
					});
				}
				return {
					content: [{ type: "text", text: `Published ${title.title}` }],
				};
			});
		},
	],
});
```

The codec signs but does not encrypt its payload. Do not place secrets in `requestState`, and do
not mint authorization claims before the corresponding response has been validated. For a
single-round confirmation, use `acceptedContent` directly and omit state entirely. An OAuth
`clientId` identifies the calling application and is not necessarily the end user; include the
tenant and subject in the binding whenever state influences user-level authorization.

## Verified application principals

The default token-free principal contains client ID, scopes, expiry, and resource. An OAuth
client ID identifies the calling application, not necessarily its end user. Configure
`principalClaims(authInfo)` when verified provider data must supply a subject or tenant for
authorization and request-state binding:

```ts
const runtime = new McpServerRuntime({
	name: "artifact-tools",
	serverInfo: { name: "artifact-tools", version: "1.0.0" },
	principalClaims: (authInfo) => ({
		subject: verifiedStringClaim(authInfo.extra, "sub"),
		tenantId: verifiedStringClaim(authInfo.extra, "tenant_id"),
	}),
});
```

The resolver runs only after the resource-server verifier has produced `AuthInfo`. Nest MCP accepts
only non-empty `subject` and `tenantId` strings from it; the bearer token and arbitrary
provider-specific `extra` fields are never copied to operation context. The verified OAuth
resource URL is projected as its canonical string rather than as a mutable `URL` object.
