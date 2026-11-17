# @nest-mcp/apps

Server-side support for the stable MCP Apps `2026-01-26` extension on direct MCP servers. The
package supplies wire constants, spec-versioned metadata types, strict normalizers, plain fragments
for Nest decorators or official SDK registration, and an `McpServerFeature` capability helper.

It intentionally contains no browser `App`/`AppBridge`, NestJS, gateway, or UI framework runtime.
The implementation targets the repository's split `@modelcontextprotocol/server` v2 package and
does not depend on the monolithic-v1 Apps server helper.

```sh
pnpm add @nest-mcp/apps @nest-mcp/server @modelcontextprotocol/server @modelcontextprotocol/node
```

## Nest decorators

The builders return ordinary object fragments accepted by the existing `@Tool()` and `@Resource()`
options. Keep the resource metadata in one value and apply it both to discovery and the
`resources/read` content so hosts receive the same security declaration on both paths.

```ts
import { Injectable } from "@nestjs/common";
import { Resource, Tool } from "@nest-mcp/nestjs";
import {
	createMcpAppResourceContent,
	createMcpAppResourceFragment,
	createMcpAppTextFallback,
	createMcpAppToolFragment,
	type CreateMcpAppResourceFragmentOptions,
} from "@nest-mcp/apps";

const VIEW_URI = "ui://weather/current" as const;
const viewSecurity = {
	csp: {
		connectDomains: ["https://api.example.com"],
		resourceDomains: ["https://cdn.example.com"],
	},
	permissions: { geolocation: {} },
	prefersBorder: true,
} satisfies CreateMcpAppResourceFragmentOptions;

@Injectable()
export class WeatherCapabilities {
	@Tool({
		name: "weather.current",
		description: "Return current weather with an optional interactive view.",
		...createMcpAppToolFragment({ resourceUri: VIEW_URI }),
	})
	current() {
		return {
			...createMcpAppTextFallback("Current temperature: 21 °C, clear."),
			structuredContent: { temperatureC: 21, conditions: "clear" },
		};
	}

	@Resource({
		name: "weather-view",
		uri: VIEW_URI,
		description: "Interactive current-weather view.",
		...createMcpAppResourceFragment(viewSecurity),
	})
	view(uri: URL) {
		return {
			contents: [
				createMcpAppResourceContent({
					uri: uri.href,
					text: "<!doctype html><html>...</html>",
					...viewSecurity,
				}),
			],
		};
	}
}
```

An adapter that owns a complete capability catalog should call
`assertMcpAppResourceLinks(tools, resources)` before serving it. The function consumes only
`{ name, _meta? }` tool definitions and structural resource definitions, ignores non-App entries,
and fails if an advertised resource URI is missing. A resource is treated as an App when it uses
`ui://`, the App MIME, or `_meta.ui`. Fragment-only consumers that cannot see a complete catalog
must keep linkage validation at their higher-level registration boundary. The assertion validates
the catalog records it receives; it cannot introspect unrelated native registrations made directly
on an `McpServer`.

Every App-enabled tool should return useful text in `content` even when it also returns
`structuredContent`. The text is what non-App clients and models can still understand; describe the
result or a useful next step rather than merely saying that an interactive view exists.

## Direct official-v2 servers

`createMcpAppsFeature()` advertises the extension on every fresh server and then invokes a normal
`McpServerFeature` for registrations:

```ts
import { McpServerRuntime } from "@nest-mcp/server";
import {
	createMcpAppsFeature,
	createMcpAppTextFallback,
	createMcpAppToolFragment,
} from "@nest-mcp/apps";

const runtime = new McpServerRuntime({
	name: "weather",
	serverInfo: { name: "weather", version: "1.0.0" },
	features: [
		createMcpAppsFeature((server) => {
			server.registerTool(
				"weather.current",
				{
					description: "Return current weather.",
					...createMcpAppToolFragment({ resourceUri: "ui://weather/current" }),
				},
				async () => createMcpAppTextFallback("Current temperature: 21 °C, clear."),
			);
			// Register the matching ui:// resource here too.
		}),
	],
});
```

For a server whose capabilities are assembled up front, use
`withMcpAppsServerCapability(existingCapabilities)` and keep registrations in an ordinary feature.
For an already-created server, `advertiseMcpApps(server)` registers the same capability. The server
must still be unconnected because the official SDK freezes capability registration on connect. The
advertisement is exactly:

```ts
{
	extensions: { "io.modelcontextprotocol/ui": {} };
}
```

MIME types belong in the client's extension settings, not the server's. `clientSupportsMcpApps()`
returns true only for a declaration containing the exact `text/html;profile=mcp-app` MIME, while
`getMcpAppsClientCapability()` returns the validated settings or `undefined`. Registration should
not depend on these helpers at `McpServerFeature` build time: split-v2 client capabilities arrive
during negotiation or on requests, after many server factories have been built. Always register
the metadata and preserve the text fallback.

## Stable wire rules

- Resource URIs begin with exact, non-empty `ui://` and contain no whitespace or controls.
- Read content uses exact `text/html;profile=mcp-app` and exactly one of `text` or base64 `blob`.
- Tool visibility contains only `"model"` and/or `"app"`; omission normalizes to both, while an
  explicit empty array stays empty. Visibility is host discovery policy, not server authorization.
- CSP entries are origin-only. `connectDomains` accepts HTTP(S) and WS(S); resource, frame, and base
  URI domains accept HTTP(S). Credentials, paths, queries, fragments, and unknown fields fail.
- Stable permission names are `camera`, `microphone`, `geolocation`, and `clipboardWrite`, each
  represented by `{}`.
- CSP and permissions belong on the resource `_meta.ui`, never the tool.

`normalizeMcpAppToolMetadata()` accepts nested `_meta.ui.resourceUri` and the deprecated flat
`_meta["ui/resourceUri"]`. Conflicting values fail. Normalized/builder output mirrors the flat key by
default for older hosts; pass `{ includeDeprecatedResourceUri: false }` for canonical-only output.
Unrelated top-level metadata is preserved. Builder `metadata` cannot contain `ui`, because the
builder owns and validates that entry.

HTML remains trusted server content. This package validates the Apps envelope and content choice;
it does not parse, sanitize, bundle, or execute HTML. The server author remains responsible for
valid HTML/base64 and for registering every resource referenced by a tool.

## Adapter contract

The minimal server-side seam consists of plain values with these return shapes:

```ts
createMcpAppToolFragment(options) => {
	_meta: {
		...options.metadata,
		ui: { resourceUri: `ui://${string}`, visibility: ("model" | "app")[] },
		"ui/resourceUri": `ui://${string}` // default compatibility mirror
	}
}

createMcpAppResourceFragment(options) => {
	mimeType: "text/html;profile=mcp-app",
	_meta?: { ...options.metadata, ui: { csp?, permissions?, domain?, prefersBorder? } }
}

createMcpAppResourceContent({ text, ...options }) => {
	uri: `ui://${string}`,
	mimeType: "text/html;profile=mcp-app",
	text: string,
	_meta?: { ...options.metadata, ui: { csp?, permissions?, domain?, prefersBorder? } }
}

createMcpAppTextFallback(text) => { content: [{ type: "text", text }] }
createMcpAppsFeature(register?) => McpServerFeature
assertMcpAppResourceLinks(
	tools: readonly { name: string, _meta?: unknown }[],
	resources: readonly { uri: string, mimeType?: unknown, _meta?: unknown }[],
) => void
```

Blob content has the same resource shape with `blob` instead of `text`. The fixed
`McpApp*20260126` types never change; unsuffixed `McpApp*` aliases track the package's current stable
spec. An adapter should consume the fragment return types and `McpServerFeature`, not recreate the
metadata schema or take a dependency on Nest decorators.

This first release is direct-server only. It does not alter or project Apps semantics through
`@nest-mcp/gateway`.

Specification: [MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/specification/2026-01-26/apps.mdx).
