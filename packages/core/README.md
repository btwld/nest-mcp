# @nest-mcp/core

Framework-neutral runtime primitives for building MCP clients, servers, gateways, and NestJS adapters. This package deliberately has no dependency on NestJS or an MCP SDK; adapters translate their SDK-specific calls into these stable operation primitives.

> This package is alpha. Public APIs may change before the first stable release.

## What it provides

- Immutable operation context and metadata with correlation, cancellation, principal, and attribute propagation.
- Onion-style middleware composition with concurrent invocation safety and a guard against calling `next()` twice.
- Result-opaque passthrough middleware for observers that must preserve the exact downstream value.
- Explicit allow/deny authorization decisions, fail-closed enforcement, and reusable authorization middleware.
- Structured started, succeeded, failed, and cancelled lifecycle events.
- Best-effort telemetry middleware that never replaces the operation result or its primary error.
- Observer fan-out that attempts every observer and reports aggregate failures.

## Installation

```sh
pnpm add @nest-mcp/core@alpha
```

## Compose an operation pipeline

```ts
import {
	allowMcpOperation,
	composeMcpLifecycleObservers,
	composeMcpMiddleware,
	createMcpAuthorizationMiddleware,
	createMcpLifecycleMiddleware,
	createMcpOperation,
	createMcpOperationContext,
	type McpAuthorizationPolicy,
} from "@nest-mcp/core";

const telemetry = composeMcpLifecycleObservers([
	{
		onEvent(event) {
			console.info(event.type, event.context.operationId);
		},
	},
]);

const policy: McpAuthorizationPolicy<{ tool: string }> = {
	authorize(operation) {
		return operation.context.principal === undefined
			? { effect: "deny", reason: "Authentication is required.", attributes: {} }
			: allowMcpOperation({ policy: "authenticated-tools" });
	},
};

const execute = composeMcpMiddleware(
	[
		createMcpLifecycleMiddleware(telemetry, {
			onObserverError(error) {
				console.error("Telemetry failed", error);
			},
		}),
		createMcpAuthorizationMiddleware(policy),
	],
	async ({ input }) => ({ content: `Called ${input.tool}` }),
);

const context = createMcpOperationContext({
	operationId: crypto.randomUUID(),
	role: "gateway",
	operation: {
		name: "tools/call",
		kind: "request",
		capability: "tools",
		target: "weather-server",
	},
	principal: { subject: "user-123" },
});

const result = await execute(createMcpOperation({ tool: "weather" }, context));
```

Middleware is entered from left to right and unwinds from right to left. A middleware continuation may be called at most once. Keep lifecycle middleware outside authorization middleware when denied attempts should produce failure telemetry.

For logging, tracing, rate limits, and similar concerns that should never transform a protocol result,
wrap a result-opaque callback with `createMcpPassthroughMiddleware`. Its `next()` resolves to `void`;
the adapter retains and returns the exact downstream value, requires the callback to continue, and
does not allow a swallowed downstream failure to become a successful result.

## Authorization is fail closed

`enforceMcpAuthorization` returns only an explicit, structurally valid allow decision. It raises `McpAuthorizationError` when:

- no policy is configured;
- the policy throws or rejects;
- the policy returns a malformed value; or
- the policy explicitly denies the operation.

The error has the stable code `MCP_AUTHORIZATION_DENIED`, a `failure` classification, the operation ID, and the deny decision. Policy exceptions are retained as the error `cause` but are not included in the public error message.

## Lifecycle and telemetry behavior

Lifecycle events contain context, timestamps, duration, and sanitized error details. They intentionally do not contain operation inputs or outputs, which reduces accidental payload or credential leakage.

The lifecycle middleware treats observers as best-effort: observer failures may be routed to `onObserverError`, but neither observer nor observer-error-handler failures replace an operation result or its primary error. `composeMcpLifecycleObservers` itself surfaces failures after attempting every observer, allowing it to remain useful outside the middleware.

## Entry points

- `@nest-mcp/core`
- `@nest-mcp/core/operation`
- `@nest-mcp/core/middleware`
- `@nest-mcp/core/authorization`
- `@nest-mcp/core/lifecycle`

## License

BSD-3-Clause
