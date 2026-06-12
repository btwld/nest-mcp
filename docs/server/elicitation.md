# Elicitation

Two complementary ways to ask the user for input during a tool call:

1. **Protocol elicitation** (`ctx.elicit`) — for MCP clients that declare the
   `elicitation` capability. The request travels over the MCP connection and
   the client renders the form.
2. **HTTP elicitation** (`McpElicitationModule`) — browser-based fallback for
   clients without elicitation support. The server hosts a small form UI and
   hands the user a URL.

## Protocol elicitation (`ctx.elicit`)

Inside any tool handler, ask the connected client for structured input:

```typescript
@Tool({ name: 'delete-repo', description: 'Delete a repository', parameters: z.object({ name: z.string() }) })
async deleteRepo({ name }: { name: string }, ctx: McpExecutionContext) {
  if (!ctx.elicit) {
    return { isError: true, content: [{ type: 'text', text: 'Client does not support elicitation' }] };
  }

  const answer = await ctx.elicit({
    message: `Really delete ${name}?`,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Type yes to confirm' } },
      required: ['confirm'],
    },
  });

  if (answer.action !== 'accept' || !answer.content?.confirm) {
    return 'Cancelled.';
  }
  return await this.repos.delete(name);
}
```

`ctx.elicit` is `undefined` when the transport/client cannot deliver
elicitation requests — always guard.

## HTTP elicitation (`McpElicitationModule`)

Hosts `GET/POST /<apiPrefix>/:elicitationId` routes that render a themed form
and collect the response out-of-band:

```typescript
@Module({
  imports: [
    McpElicitationModule.forRoot({
      serverUrl: 'https://api.example.com', // used to build user-facing URLs
      apiPrefix: 'elicitation',             // default
      elicitationTtlMs: 60 * 60 * 1000,     // default 1h
      storeConfiguration: { type: 'memory' }, // or { type: 'custom', store }
      guards: [SessionGuard],               // applied to every elicitation route
      templateOptions: { appName: 'My Server', primaryColor: '#0a7', logoUrl: '...' },
    }),
  ],
})
class AppModule {}
```

Inject `ElicitationService` in a tool to create a pending elicitation, return
its URL to the model, and await the user's submission. Stores implement
`IElicitationStore` (in-memory provided; bring your own for multi-instance
deployments).

## See Also

- [Module configuration](./module.md)
- [Sessions](./sessions.md)
