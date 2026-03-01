# Policies

The policy engine controls access to tools by evaluating rules against tool names and an optional context containing user identity, roles, and scopes.

## Configuration

Policies are configured via the `policies` option in `McpGatewayOptions`:

```typescript
import { McpGatewayModule } from '@nest-mcp/gateway';

McpGatewayModule.forRoot({
  server: { name: 'my-gateway', version: '1.0.0' },
  upstreams: [/* ... */],
  policies: {
    defaultEffect: 'deny',
    rules: [
      { pattern: 'weather_*', effect: 'allow' },
      { pattern: 'gh_delete_*', effect: 'deny', reason: 'Destructive operations blocked' },
      { pattern: 'gh_*', effect: 'allow', roles: ['developer'] },
      { pattern: 'admin_*', effect: 'require_approval', reason: 'Admin tools need approval' },
    ],
  },
})
```

### PoliciesConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `defaultEffect` | `'allow' \| 'deny' \| 'require_approval'` | Yes | Effect applied when no rule matches the tool name. |
| `rules` | `PolicyRule[]` | Yes | Ordered list of rules. The first matching rule wins. |

### PolicyRule

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `pattern` | `string` | Yes | Glob pattern matched against the prefixed tool name. Supports `*` (any characters) and `?` (single character). |
| `effect` | `'allow' \| 'deny' \| 'require_approval'` | Yes | The effect if this rule matches. |
| `reason` | `string` | No | Human-readable reason returned when the tool call is denied or requires approval. |
| `roles` | `string[]` | No | If set, the rule only matches when the caller has at least one of these roles. |
| `scopes` | `string[]` | No | If set, the rule only matches when the caller has at least one of these scopes. |
| `userMatch` | `string` | No | Glob pattern matched against the caller's `userId`. |

## Policy effects

| Effect | Behavior |
|--------|----------|
| `allow` | The tool call proceeds normally. |
| `deny` | The tool call is rejected immediately. The response contains an error message with the rule's `reason`. |
| `require_approval` | The tool call is rejected with an approval-required message. Your application can implement an approval workflow on top of this. |

## Evaluation order

Rules are evaluated in the order they appear in the `rules` array. The first rule whose `pattern` matches the tool name **and** whose context constraints (`roles`, `scopes`, `userMatch`) are satisfied determines the effect. If no rule matches, `defaultEffect` is used.

## PolicyContext

The optional `PolicyContext` provides identity information about the caller:

```typescript
import type { PolicyContext } from '@nest-mcp/gateway';

const context: PolicyContext = {
  userId: 'user-123',
  roles: ['developer', 'reviewer'],
  scopes: ['tools:read', 'tools:write'],
};
```

| Property | Type | Description |
|----------|------|-------------|
| `userId` | `string` | Identifier for the calling user. Matched against `userMatch` in rules. |
| `roles` | `string[]` | Roles assigned to the caller. Matched against `roles` in rules. |
| `scopes` | `string[]` | Scopes/permissions for the caller. Matched against `scopes` in rules. |

The context is passed as the second argument to `GatewayService.callTool()`. If you are using the gateway's auto-registered tool handlers (the default), the context is not set automatically -- you would need to customize the tool handler registration to inject context from your authentication layer.

## RBAC example

Restrict admin tools to users with the `admin` role:

```typescript
policies: {
  defaultEffect: 'allow',
  rules: [
    { pattern: 'admin_*', effect: 'deny', reason: 'Admin access required', roles: ['admin'] },
  ],
}
```

With this configuration:
- A call to `admin_reset` from a context with `roles: ['admin']` matches the rule. Since the rule's effect is `deny` and the context matches the role constraint, the rule applies and the call is denied.
- A call to `admin_reset` from a context without the `admin` role does not match the role constraint, so the rule is skipped and `defaultEffect: 'allow'` applies.

To flip this logic (deny by default, allow for admins), reverse the structure:

```typescript
policies: {
  defaultEffect: 'deny',
  rules: [
    { pattern: 'admin_*', effect: 'allow', roles: ['admin'] },
    { pattern: 'weather_*', effect: 'allow' },
  ],
}
```

## Using the PolicyEngineService directly

```typescript
import { Injectable } from '@nestjs/common';
import { PolicyEngineService } from '@nest-mcp/gateway';

@Injectable()
export class MyService {
  constructor(private readonly policyEngine: PolicyEngineService) {}

  checkAccess(toolName: string) {
    const result = this.policyEngine.evaluate(toolName, {
      userId: 'user-123',
      roles: ['developer'],
    });

    if (result.effect === 'deny') {
      console.log(`Denied: ${result.reason}`);
    }
  }
}
```

## See Also

- [Routing](./routing.md) -- policy patterns match against prefixed tool names
- [Module](./module.md) -- where to configure policies
- [Transforms](./transforms.md) -- transforms run after policy evaluation
