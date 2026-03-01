# Transforms

The gateway provides request and response transform hooks that let you modify tool call data as it flows through the proxy pipeline. Transforms run as a chain of functions -- each receives the output of the previous one.

## Pipeline order

When `GatewayService.callTool()` is invoked, the pipeline runs in this order:

1. Policy evaluation
2. Route resolution
3. Cache lookup
4. **Request transforms** (modify tool name and arguments before the upstream call)
5. Upstream call
6. **Response transforms** (modify content and error flag after the upstream responds)
7. Cache store

## RequestTransformService

Register functions that modify the request before it reaches the upstream server.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestTransformService } from '@nest-mcp/gateway';
import type { ToolCallRequest } from '@nest-mcp/gateway';

@Injectable()
export class MyRequestTransform implements OnModuleInit {
  constructor(private readonly requestTransform: RequestTransformService) {}

  onModuleInit() {
    this.requestTransform.register((request: ToolCallRequest) => {
      // Add a timestamp to all tool call arguments
      return {
        ...request,
        arguments: {
          ...request.arguments,
          _gatewayTimestamp: Date.now(),
        },
      };
    });
  }
}
```

### ToolCallRequest

The shape passed through request transforms:

```typescript
interface ToolCallRequest {
  toolName: string;                    // Original (unprefixed) tool name
  arguments: Record<string, unknown>;  // Tool call arguments
  upstreamName: string;                // Target upstream name
}
```

Note that `toolName` is the **original** upstream tool name (after prefix stripping), not the gateway-prefixed name.

### RequestTransformFn

```typescript
type RequestTransformFn = (
  request: ToolCallRequest,
) => ToolCallRequest | Promise<ToolCallRequest>;
```

Transform functions can be synchronous or asynchronous. If a transform throws an error, the entire tool call fails.

## ResponseTransformService

Register functions that modify the response after the upstream responds.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ResponseTransformService } from '@nest-mcp/gateway';
import type { ToolCallResponse } from '@nest-mcp/gateway';

@Injectable()
export class MyResponseTransform implements OnModuleInit {
  constructor(private readonly responseTransform: ResponseTransformService) {}

  onModuleInit() {
    this.responseTransform.register((response: ToolCallResponse) => {
      // Add a metadata wrapper around text content
      return {
        ...response,
        content: response.content.map((item) => {
          if (item.type === 'text') {
            return {
              ...item,
              text: `[via ${response.upstreamName}] ${item.text}`,
            };
          }
          return item;
        }),
      };
    });
  }
}
```

### ToolCallResponse

The shape passed through response transforms:

```typescript
interface ToolCallResponse {
  toolName: string;        // Gateway-prefixed tool name
  upstreamName: string;    // Source upstream name
  content: ToolContent[];  // Response content items
  isError?: boolean;       // Whether the upstream reported an error
}
```

### ResponseTransformFn

```typescript
type ResponseTransformFn = (
  response: ToolCallResponse,
) => ToolCallResponse | Promise<ToolCallResponse>;
```

## Chaining multiple transforms

Transforms are applied in registration order. Each transform receives the output of the previous one:

```typescript
// First transform runs first
requestTransform.register((req) => {
  console.log('Transform 1');
  return req;
});

// Second transform receives output of the first
requestTransform.register((req) => {
  console.log('Transform 2');
  return req;
});
```

## Error handling

If any transform function throws an error, the pipeline is aborted and the error propagates up. The error message is logged by the transform service. No further transforms in the chain are executed after a failure.

## See Also

- [Policies](./policies.md) -- policies are evaluated before transforms
- [Caching](./caching.md) -- caching happens after response transforms
- [Module](./module.md) -- module configuration
