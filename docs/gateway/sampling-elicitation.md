# Sampling & Elicitation

The MCP protocol allows servers to request **sampling** (asking an LLM to generate a response) and **elicitation** (asking the user for structured input) during tool execution. The gateway transparently forwards these requests between upstream servers and the downstream client.

## How it works

When a downstream client calls a tool through the gateway:

1. The gateway activates sampling and elicitation forwarders for the target upstream.
2. The tool call is forwarded to the upstream server.
3. If the upstream server sends a `sampling/createMessage` request during execution, the gateway forwards it to the downstream client's `createMessage` callback.
4. If the upstream server sends an `elicitation/elicit` request during execution, the gateway forwards it to the downstream client's `elicit` callback.
5. The downstream client's response is relayed back to the upstream server.
6. After the tool call completes (whether successfully or with an error), the forwarders are deactivated.

This means upstream servers can use sampling and elicitation as if they were communicating directly with the client, while the gateway handles the relay transparently.

## Architecture

The forwarding is managed by the `UpstreamManagerService`, which maintains per-upstream forwarder maps:

```
Downstream Client  <-->  Gateway  <-->  Upstream Server
                          |
                    UpstreamManagerService
                    - samplingForwarders (Map)
                    - elicitForwarders (Map)
```

### Activation lifecycle

```
callTool() starts
  |-> activateSampling(upstreamName, createMessage)
  |-> activateElicitation(upstreamName, elicit)
  |-> client.callTool(...)   // upstream may send sampling/elicitation requests
  |-> deactivateSampling(upstreamName)
  |-> deactivateElicitation(upstreamName)
callTool() ends
```

Deactivation happens in a `finally` block, so forwarders are always cleaned up even if the tool call fails.

## Client capabilities

When the gateway connects to an upstream, it advertises both `sampling` and `elicitation` capabilities:

```typescript
const client = new Client(
  { name: `gateway-to-${config.name}`, version: '1.0.0' },
  {
    capabilities: {
      sampling: {},
      elicitation: {},
    },
  },
);
```

This tells the upstream server that it can send sampling and elicitation requests.

## Error handling

If an upstream sends a sampling or elicitation request but no downstream client context is active (i.e. the forwarder is not set), the gateway throws an error:

```
Upstream "weather" requested sampling but no downstream client context is active
```

This can happen if a sampling/elicitation request arrives outside the context of an active tool call.

## Limitations

- Only one downstream client context can be active per upstream at a time. If two clients call tools on the same upstream concurrently, the second call's forwarder overwrites the first.
- The gateway does not transform or modify sampling/elicitation payloads -- they are passed through as-is.

## See Also

- [Upstreams](./upstreams.md) -- upstream connection and client capabilities
- [Module](./module.md) -- bootstrap lifecycle
- [Transforms](./transforms.md) -- request/response transforms (separate from sampling/elicitation)
