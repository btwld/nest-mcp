# @nest-mcp/common

[![npm version](https://img.shields.io/npm/v/@nest-mcp/common.svg)](https://www.npmjs.com/package/@nest-mcp/common)
[![License](https://img.shields.io/npm/l/@nest-mcp/common)](https://github.com/btwld/nest-mcp/blob/main/LICENSE)
[![CI](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml)

Shared types, utilities, and constants for the `nest-mcp` toolkit. This package is a peer dependency of `@nest-mcp/server`, `@nest-mcp/client`, and `@nest-mcp/gateway` — you rarely need to install it directly.

## Installation

```bash
npm install @nest-mcp/common
```

## Contents

- **Types** — `McpExecutionContext`, `McpModuleOptions`, `ToolCallResult`, `ResourceReadResult`, `PromptGetResult`, and more
- **Enums** — `McpTransportType` (STREAMABLE_HTTP, SSE, STDIO)
- **Errors** — `ToolExecutionError`, `ValidationError`
- **Utilities** — `zodToJsonSchema`, `matchUriTemplate`, `paginate`, `extractZodDescriptions`
- **Tokens** — `MCP_OPTIONS`, `MCP_CLIENT_OPTIONS`

## Usage

```typescript
import { McpTransportType, McpExecutionContext } from '@nest-mcp/common';
```

Most users interact with this package indirectly through `@nest-mcp/server`, `@nest-mcp/client`, or `@nest-mcp/gateway`.

## Documentation

Full documentation: [github.com/btwld/nest-mcp](https://github.com/btwld/nest-mcp)

## License

BSD-3-Clause
