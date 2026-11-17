import { z } from "zod";

const dateTimeSchema = z.string().datetime({ offset: true });
const metaSchema = z.record(z.string(), z.unknown());

const iconSchema = z
  .object({
    src: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizes: z.array(z.string().min(1)).optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .passthrough();

const annotationsSchema = z
  .object({
    audience: z.array(z.enum(["user", "assistant"])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: dateTimeSchema.optional(),
  })
  .passthrough();

export const runtimeCapabilitiesSchema = z
  .object({
    tools: z.boolean(),
    resources: z.boolean(),
    prompts: z.boolean(),
    completion: z.boolean(),
    subscriptions: z.boolean(),
  })
  .strict();

export const runtimePhaseSchema = z.enum([
  "offline",
  "queued",
  "connecting",
  "online",
  "degraded",
  "draining",
  "failed",
  "quarantined",
]);

export const runtimeStateSchema = z
  .object({
    phase: runtimePhaseSchema,
    lastTransitionAt: dateTimeSchema,
    protocolVersion: z.string().min(1).optional(),
    protocolEra: z.string().min(1).optional(),
    connectedAt: dateTimeSchema.optional(),
    errorCode: z.string().min(1).optional(),
    capabilities: runtimeCapabilitiesSchema.optional(),
  })
  .strict();

export const oauthAuthenticationStatusSchema = z.enum([
  "authorization-required",
  "authorizing",
  "authorized",
  "reauthorization-required",
  "failed",
]);

const noAuthenticationSchema = z
  .object({
    kind: z.literal("none"),
    configured: z.literal(true),
  })
  .strict();

const oauthAuthenticationSchema = z
  .object({
    kind: z.literal("oauth"),
    status: oauthAuthenticationStatusSchema,
    authorizationServerHost: z.string().trim().min(1).max(253).optional(),
    scopes: z.array(z.string().trim().min(1).max(512)).max(64).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
      .optional(),
  })
  .strict();

export const connectionAuthenticationSchema = z.discriminatedUnion("kind", [
  noAuthenticationSchema,
  oauthAuthenticationSchema,
]);

export const connectionSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    runtimeGeneration: z.number().int().positive(),
    displayName: z.string().min(1).max(120),
    desiredState: z.enum(["offline", "online"]),
    deletionPending: z.boolean(),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    transport: z
      .object({
        kind: z.literal("http"),
        host: z.string().min(1),
      })
      .strict(),
    authentication: connectionAuthenticationSchema,
    runtime: runtimeStateSchema,
  })
  .strict();

export const connectionsSchema = z.array(connectionSchema);

export const runtimeManagerSchema = z
  .object({
    closed: z.boolean(),
    maxConnections: z.number().int().positive(),
    connectionCount: z.number().int().nonnegative(),
    pendingConnectionCount: z.number().int().nonnegative(),
    activeConnectionCount: z.number().int().nonnegative(),
    closingConnectionCount: z.number().int().nonnegative(),
    quarantinedConnectionCount: z.number().int().nonnegative(),
    operationReferenceCount: z.number().int().nonnegative(),
    onlineKeeperCount: z.number().int().nonnegative(),
  })
  .strict();

export const liveHealthSchema = z.object({ status: z.literal("live") }).strict();
export const readyHealthSchema = z.object({ status: z.literal("ready") }).strict();

const metricCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metricMillisecondsSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const metricOutcomesSchema = z
  .object({
    success: metricCountSchema,
    error: metricCountSchema,
    cancelled: metricCountSchema,
  })
  .strict();

export const metricDurationSummarySchema = z
  .object({
    count: metricCountSchema,
    averageMs: metricMillisecondsSchema.nullable(),
    p50Ms: metricMillisecondsSchema.nullable(),
    p95Ms: metricMillisecondsSchema.nullable(),
    maxMs: metricMillisecondsSchema.nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    const values = [summary.averageMs, summary.p50Ms, summary.p95Ms, summary.maxMs];
    if (summary.count === 0) {
      if (values.some((value) => value !== null)) {
        context.addIssue({
          code: "custom",
          message: "Empty duration summaries must use null statistics.",
        });
      }
      return;
    }

    if (
      summary.averageMs === null ||
      summary.p50Ms === null ||
      summary.p95Ms === null ||
      summary.maxMs === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Non-empty duration summaries must include every statistic.",
      });
      return;
    }

    if (summary.p50Ms > summary.p95Ms || summary.p95Ms > summary.maxMs) {
      context.addIssue({
        code: "custom",
        message: "Duration percentiles must satisfy p50 <= p95 <= max.",
      });
    }
    if (summary.averageMs > summary.maxMs) {
      context.addIssue({
        code: "custom",
        message: "Average duration cannot exceed the maximum duration.",
      });
    }
  });

const metricAggregateShape = {
  started: metricCountSchema,
  active: metricCountSchema,
  outcomes: metricOutcomesSchema,
  duration: metricDurationSummarySchema,
} as const;

function completedMetricCount(outcomes: z.infer<typeof metricOutcomesSchema>): number {
  return outcomes.success + outcomes.error + outcomes.cancelled;
}

function refineMetricAggregate(
  aggregate: z.infer<z.ZodObject<typeof metricAggregateShape>>,
  context: z.core.$RefinementCtx,
): void {
  const completed = completedMetricCount(aggregate.outcomes);
  if (aggregate.duration.count !== completed) {
    context.addIssue({
      code: "custom",
      message: "Duration count must match completed outcomes.",
      path: ["duration", "count"],
    });
  }
  if (aggregate.started !== completed + aggregate.active) {
    context.addIssue({
      code: "custom",
      message: "Started operations must equal completed plus active operations.",
      path: ["started"],
    });
  }
}

export const metricAggregateSchema = z
  .object(metricAggregateShape)
  .strict()
  .superRefine(refineMetricAggregate);

export const metricsBucketSchema = z
  .object({
    startedAt: dateTimeSchema,
    started: metricCountSchema,
    outcomes: metricOutcomesSchema,
    duration: metricDurationSummarySchema,
  })
  .strict()
  .superRefine((bucket, context) => {
    if (bucket.duration.count !== completedMetricCount(bucket.outcomes)) {
      context.addIssue({
        code: "custom",
        message: "Bucket duration count must match completed outcomes.",
        path: ["duration", "count"],
      });
    }
  });

export const operationMetricsSchema = z
  .object({
    role: z.enum(["client", "server", "gateway"]),
    name: z.string().min(1).max(128),
    kind: z.enum(["request", "notification"]),
    capability: z.string().min(1).max(128).optional(),
    ...metricAggregateShape,
  })
  .strict()
  .superRefine(refineMetricAggregate);

export const metricsSnapshotSchema = z
  .object({
    scope: z.literal("process"),
    startedAt: dateTimeSchema,
    capturedAt: dateTimeSchema,
    totals: metricAggregateSchema,
    window: z
      .object({
        bucketSeconds: z.number().int().min(1).max(300),
        buckets: z.array(metricsBucketSchema).max(60),
      })
      .strict(),
    operations: z.array(operationMetricsSchema).max(100),
    operationsTruncated: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const processStartedAt = Date.parse(snapshot.startedAt);
    const capturedAt = Date.parse(snapshot.capturedAt);
    if (processStartedAt > capturedAt) {
      context.addIssue({
        code: "custom",
        message: "Metrics capture cannot precede process start.",
        path: ["capturedAt"],
      });
    }

    let previousBucketStartedAt = Number.NEGATIVE_INFINITY;
    snapshot.window.buckets.forEach((bucket, index) => {
      const bucketStartedAt = Date.parse(bucket.startedAt);
      if (bucketStartedAt <= previousBucketStartedAt) {
        context.addIssue({
          code: "custom",
          message: "Metrics buckets must be strictly chronological.",
          path: ["window", "buckets", index, "startedAt"],
        });
      }
      if (bucketStartedAt < processStartedAt) {
        context.addIssue({
          code: "custom",
          message: "Metrics buckets cannot start before process metrics collection.",
          path: ["window", "buckets", index, "startedAt"],
        });
      }
      if (bucketStartedAt > capturedAt) {
        context.addIssue({
          code: "custom",
          message: "Metrics buckets cannot start after capture time.",
          path: ["window", "buckets", index, "startedAt"],
        });
      }
      previousBucketStartedAt = bucketStartedAt;
    });

    const operationKeys = new Set<string>();
    snapshot.operations.forEach((operation, index) => {
      const key = JSON.stringify([
        operation.role,
        operation.name,
        operation.kind,
        operation.capability ?? null,
      ]);
      if (operationKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Metrics operation groups must be unique.",
          path: ["operations", index],
        });
      }
      operationKeys.add(key);
    });
  });

const toolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

const toolExecutionSchema = z
  .object({
    taskSupport: z.enum(["required", "optional", "forbidden"]).optional(),
  })
  .passthrough();

const jsonSchemaObject = z.record(z.string(), z.unknown());

const textToolResultContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const binaryToolResultContentSchema = z
  .object({
    type: z.enum(["image", "audio"]),
    data: z.string(),
    mimeType: z.string().min(1),
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const resourceLinkToolResultContentSchema = z
  .object({
    type: z.literal("resource_link"),
    name: z.string().min(1),
    uri: z.string().min(1),
    title: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().nonnegative().optional(),
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const embeddedResourceContentsSchema = z
  .object({
    uri: z.string().min(1),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough()
  .superRefine((resource, context) => {
    if (resource.text === undefined && resource.blob === undefined) {
      context.addIssue({
        code: "custom",
        message: "An embedded resource must contain text or blob data.",
      });
    }
  });

const embeddedResourceToolResultContentSchema = z
  .object({
    type: z.literal("resource"),
    resource: embeddedResourceContentsSchema,
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const knownToolResultContentSchemas = {
  text: textToolResultContentSchema,
  image: binaryToolResultContentSchema,
  audio: binaryToolResultContentSchema,
  resource_link: resourceLinkToolResultContentSchema,
  resource: embeddedResourceToolResultContentSchema,
} as const;

export const toolResultContentSchema = z
  .object({ type: z.string().min(1) })
  .passthrough()
  .superRefine((content, context) => {
    const schema =
      knownToolResultContentSchemas[content.type as keyof typeof knownToolResultContentSchemas];
    if (schema === undefined) return;

    const parsed = schema.safeParse(content);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
    }
  });

export const toolCallResultSchema = z
  .object({
    content: z.array(toolResultContentSchema),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

export const toolCallInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const readResourceInputSchema = z
  .object({
    uri: z.string().min(1).max(4_096),
  })
  .strict();

export const readResourceResultSchema = z
  .object({
    contents: z.array(embeddedResourceContentsSchema),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const promptArgumentsInputSchema = z
  .record(z.string().min(1).max(200), z.string().max(16 * 1_024))
  .superRefine((arguments_, context) => {
    if (Object.keys(arguments_).length > 64) {
      context.addIssue({ code: "custom", message: "Use at most 64 prompt arguments." });
    }
    if (new TextEncoder().encode(JSON.stringify(arguments_)).byteLength > 64 * 1_024) {
      context.addIssue({
        code: "custom",
        message: "Prompt arguments must fit within a 64 KiB request payload.",
      });
    }
  });

export const getPromptInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    arguments: promptArgumentsInputSchema.optional(),
  })
  .strict();

export const promptMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: toolResultContentSchema,
  })
  .passthrough();

export const getPromptResultSchema = z
  .object({
    description: z.string().optional(),
    messages: z.array(promptMessageSchema),
    _meta: metaSchema.optional(),
  })
  .passthrough();

export const toolSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    description: z.string().optional(),
    inputSchema: jsonSchemaObject,
    outputSchema: jsonSchemaObject.optional(),
    annotations: toolAnnotationsSchema.optional(),
    execution: toolExecutionSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough()
  .superRefine((tool, context) => {
    if (tool.inputSchema.type !== "object") {
      context.addIssue({
        code: "custom",
        message: "A tool input schema must have type 'object'.",
        path: ["inputSchema", "type"],
      });
    }
  });

export const resourceSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    uri: z.string().min(1),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().nonnegative().optional(),
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

export const resourceTemplateSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    uriTemplate: z.string().min(1),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    annotations: annotationsSchema.optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

const promptArgumentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .passthrough();

export const promptSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    description: z.string().optional(),
    arguments: z.array(promptArgumentSchema).optional(),
    _meta: metaSchema.optional(),
  })
  .passthrough();

export const catalogSchema = z
  .object({
    connectionId: z.string().uuid(),
    runtimeGeneration: z.number().int().positive(),
    discoveredAt: dateTimeSchema,
    tools: z.array(toolSchema),
    resources: z.array(resourceSchema),
    resourceTemplates: z.array(resourceTemplateSchema),
    prompts: z.array(promptSchema),
  })
  .strict();

export const hubNamespaceSchema = z
  .string()
  .min(1, "Enter a routing label.")
  .max(32, "Use 32 characters or fewer.")
  .regex(
    /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u,
    "Use lowercase letters, numbers, and internal hyphens; start with a letter.",
  );

export const hubCountsSchema = z
  .object({
    tools: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resources: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resourceTemplates: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    prompts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const hubMemberSchema = z
  .object({
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    runtimeGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    namespace: hubNamespaceSchema,
    displayName: z.string().min(1).max(120),
    attachedAt: dateTimeSchema,
    runtime: z
      .object({
        phase: runtimePhaseSchema,
      })
      .strict(),
  })
  .strict();

export const hubSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    updatedAt: dateTimeSchema,
    endpoint: z
      .object({
        transport: z.literal("streamable-http"),
        path: z.literal("/mcp/hub"),
      })
      .strict(),
    members: z.array(hubMemberSchema).max(1_000),
    counts: hubCountsSchema,
  })
  .strict()
  .superRefine((hub, context) => {
    const connectionIds = new Set<string>();
    const namespaces = new Set<string>();
    hub.members.forEach((member, index) => {
      if (connectionIds.has(member.connectionId)) {
        context.addIssue({
          code: "custom",
          message: "Hub members must have unique connection IDs.",
          path: ["members", index, "connectionId"],
        });
      }
      connectionIds.add(member.connectionId);

      if (namespaces.has(member.namespace)) {
        context.addIssue({
          code: "custom",
          message: "Hub members must have unique namespaces.",
          path: ["members", index, "namespace"],
        });
      }
      namespaces.add(member.namespace);
    });
  });

const hubCatalogOriginShape = {
  namespace: hubNamespaceSchema,
  sourceName: z.string().min(1),
  projectedName: z.string().min(1),
  definition: z.record(z.string(), z.unknown()),
} as const;

const hubCatalogToolSchema = z.object(hubCatalogOriginShape).strict();
const hubCatalogResourceSchema = z
  .object({
    ...hubCatalogOriginShape,
    projectedUri: z.string().min(1),
  })
  .strict();
const hubCatalogResourceTemplateSchema = z
  .object({
    ...hubCatalogOriginShape,
    projectedUriTemplate: z.string().min(1),
  })
  .strict();

export const hubCatalogSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    publishedAt: dateTimeSchema,
    tools: z.array(hubCatalogToolSchema),
    resources: z.array(hubCatalogResourceSchema),
    resourceTemplates: z.array(hubCatalogResourceTemplateSchema),
    prompts: z.array(hubCatalogToolSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const unique = (
      values: readonly string[],
      path: "tools" | "resources" | "resourceTemplates" | "prompts",
      field: "projectedName" | "projectedUri" | "projectedUriTemplate",
    ): void => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Hub catalog ${field} values must be unique.`,
            path: [path, index, field],
          });
        }
        seen.add(value);
      });
    };

    unique(
      catalog.tools.map((item) => item.projectedName),
      "tools",
      "projectedName",
    );
    unique(
      catalog.resources.map((item) => item.projectedUri),
      "resources",
      "projectedUri",
    );
    unique(
      catalog.resourceTemplates.map((item) => item.projectedUriTemplate),
      "resourceTemplates",
      "projectedUriTemplate",
    );
    unique(
      catalog.prompts.map((item) => item.projectedName),
      "prompts",
      "projectedName",
    );
  });

export const probeSchema = z
  .object({
    reachable: z.literal(true),
    observedAt: dateTimeSchema,
    protocolVersion: z.string().min(1).optional(),
    protocolEra: z.string().min(1).optional(),
    capabilities: runtimeCapabilitiesSchema.optional(),
    runtime: runtimeStateSchema,
  })
  .strict();

export const problemDetailsSchema = z
  .object({
    statusCode: z.number().int().min(400).max(599),
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.array(z.string()).optional(),
  })
  .strict();

const conformanceIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const conformanceCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
const conformanceFingerprintSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u);
const conformanceCheckRiskSchema = z.enum(["read-only", "side-effecting"]);
const conformanceCheckStatusSchema = z.enum(["pass", "warn", "fail", "skip", "error"]);
const conformanceVerdictSchema = z.enum(["pass", "warn", "fail", "inconclusive"]);
const conformanceSafeIntegerSchema = z.number().int().max(Number.MAX_SAFE_INTEGER);
const conformanceCountSchema = conformanceSafeIntegerSchema.nonnegative();
const conformancePositiveIntegerSchema = conformanceSafeIntegerSchema.positive();

const conformancePlanCheckSchema = z
  .object({
    id: conformanceIdentifierSchema,
    title: z.string().min(1).max(120),
    risk: conformanceCheckRiskSchema,
  })
  .strict();

export const conformanceReportSchema = z
  .object({
    reportSchemaVersion: z.literal(1),
    fingerprintVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    plan: z
      .object({
        id: conformanceIdentifierSchema,
        version: z.string().min(1).max(64),
        title: z.string().min(1).max(120),
        digest: conformanceFingerprintSchema,
        checks: z.array(conformancePlanCheckSchema).min(1).max(128),
      })
      .strict(),
    descriptor: z
      .object({
        target: z
          .object({
            kind: conformanceIdentifierSchema,
            id: z.string().min(1).max(256),
            revision: conformancePositiveIntegerSchema.optional(),
            generation: conformancePositiveIntegerSchema.optional(),
          })
          .strict(),
        subject: z
          .object({
            name: z.string().min(1).max(256),
            version: z.string().min(1).max(256),
            revision: z.string().min(1).max(256).optional(),
          })
          .strict(),
        fixtureVersion: z.string().min(1).max(256).optional(),
      })
      .strict(),
    startedAt: dateTimeSchema,
    finishedAt: dateTimeSchema,
    durationMs: conformanceCountSchema,
    completion: z.enum(["completed", "cancelled", "timed-out"]),
    verdict: conformanceVerdictSchema,
    counts: z
      .object({
        pass: conformanceCountSchema,
        warn: conformanceCountSchema,
        fail: conformanceCountSchema,
        skip: conformanceCountSchema,
        error: conformanceCountSchema,
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            id: conformanceIdentifierSchema,
            title: z.string().min(1).max(120),
            risk: conformanceCheckRiskSchema,
            status: conformanceCheckStatusSchema,
            code: conformanceCodeSchema,
            durationMs: conformanceCountSchema,
            facts: z
              .record(
                z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/u),
                z.union([
                  z.string().max(1_024),
                  z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
                  z.boolean(),
                  z.null(),
                ]),
              )
              .refine((facts) => Object.keys(facts).length <= 64, {
                message: "A conformance check contains too many facts.",
              }),
            factsOmittedCount: conformanceCountSchema,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.plan.checks.length !== report.checks.length) {
      context.addIssue({ code: "custom", message: "Plan and report check counts differ." });
      return;
    }
    const ids = new Set<string>();
    report.checks.forEach((check, index) => {
      const planned = report.plan.checks[index];
      if (ids.has(check.id)) {
        context.addIssue({
          code: "custom",
          message: "Conformance check IDs must be unique.",
          path: ["checks", index, "id"],
        });
      }
      ids.add(check.id);
      if (
        planned === undefined ||
        planned.id !== check.id ||
        planned.title !== check.title ||
        planned.risk !== check.risk
      ) {
        context.addIssue({
          code: "custom",
          message: "Plan and report check order differ.",
          path: ["checks", index],
        });
      }
    });
    for (const status of conformanceCheckStatusSchema.options) {
      const observed = report.checks.filter((check) => check.status === status).length;
      if (observed !== report.counts[status]) {
        context.addIssue({
          code: "custom",
          message: "Conformance status counts are inconsistent.",
          path: ["counts", status],
        });
      }
    }
    const expectedVerdict =
      report.completion !== "completed" || report.counts.error > 0
        ? "inconclusive"
        : report.counts.fail > 0
          ? "fail"
          : report.counts.warn > 0
            ? "warn"
            : report.counts.pass > 0
              ? "pass"
              : "inconclusive";
    if (report.verdict !== expectedVerdict) {
      context.addIssue({
        code: "custom",
        message: "The conformance verdict is inconsistent.",
        path: ["verdict"],
      });
    }
    if (Date.parse(report.finishedAt) - Date.parse(report.startedAt) !== report.durationMs) {
      context.addIssue({
        code: "custom",
        message: "The conformance duration is inconsistent.",
        path: ["durationMs"],
      });
    }
  });

export const conformanceRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "timed-out",
  "failed",
]);

export const conformanceRunSchema = z
  .object({
    runId: z.string().uuid(),
    planId: z.literal("safe-discovery-v1"),
    status: conformanceRunStatusSchema,
    target: z
      .object({
        kind: z.literal("connection"),
        connectionId: z.string().uuid(),
        expectedRevision: conformancePositiveIntegerSchema,
        runtimeGeneration: conformancePositiveIntegerSchema,
      })
      .strict(),
    createdAt: dateTimeSchema,
    startedAt: dateTimeSchema.optional(),
    finishedAt: dateTimeSchema.optional(),
    report: conformanceReportSchema.optional(),
    errorCode: conformanceCodeSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = ["completed", "cancelled", "timed-out", "failed"].includes(run.status);
    if (terminal && run.finishedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Terminal conformance runs require finishedAt.",
        path: ["finishedAt"],
      });
    }
    if (!terminal && (run.finishedAt !== undefined || run.report !== undefined || run.errorCode)) {
      context.addIssue({
        code: "custom",
        message: "Active conformance runs cannot carry terminal evidence.",
      });
    }
    if (run.status === "failed") {
      if (run.errorCode === undefined) {
        context.addIssue({
          code: "custom",
          message: "Failed conformance runs require an error code.",
          path: ["errorCode"],
        });
      }
      if (run.report !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Failed conformance runs cannot carry an accepted report.",
          path: ["report"],
        });
      }
    } else if (run.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only failed conformance runs can carry an error code.",
        path: ["errorCode"],
      });
    }
    if ((run.status === "completed" || run.status === "timed-out") && run.report === undefined) {
      context.addIssue({
        code: "custom",
        message: "This terminal conformance status requires a report.",
        path: ["report"],
      });
    }
    if (run.report === undefined) return;
    const expectedStatus =
      run.report.completion === "completed"
        ? "completed"
        : run.report.completion === "cancelled"
          ? "cancelled"
          : "timed-out";
    if (
      run.status !== expectedStatus ||
      run.report.runId !== run.runId ||
      run.report.plan.id !== run.planId ||
      run.report.descriptor.target.kind !== run.target.kind ||
      run.report.descriptor.target.id !== run.target.connectionId ||
      run.report.descriptor.target.revision !== run.target.expectedRevision ||
      run.report.descriptor.target.generation !== run.target.runtimeGeneration
    ) {
      context.addIssue({
        code: "custom",
        message: "The conformance report does not match its run envelope.",
        path: ["report"],
      });
    }
  });

export const conformanceRunsSchema = z
  .object({ runs: z.array(conformanceRunSchema).max(100) })
  .strict();

const endpointSchema = z
  .string()
  .trim()
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Use an http:// or https:// endpoint.",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Enter a valid endpoint URL." });
    }
  });

const displayNameSchema = z.string().trim().min(1, "Enter a display name.").max(120);

export const connectionAuthenticationInputSchema = z
  .object({
    kind: z.enum(["none", "oauth"]),
  })
  .strict();

export const connectionDraftSchema = z
  .object({
    displayName: displayNameSchema,
    endpoint: endpointSchema,
    authentication: connectionAuthenticationInputSchema,
  })
  .strict();

export const connectionUpdateSchema = z
  .object({
    displayName: displayNameSchema,
    endpoint: endpointSchema.optional(),
  })
  .strict();

export type RuntimePhase = z.infer<typeof runtimePhaseSchema>;
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type OAuthAuthenticationStatus = z.infer<typeof oauthAuthenticationStatusSchema>;
export type ConnectionAuthentication = z.infer<typeof connectionAuthenticationSchema>;
export type ConnectionAuthenticationInput = z.infer<typeof connectionAuthenticationInputSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type RuntimeManager = z.infer<typeof runtimeManagerSchema>;
export type LiveHealth = z.infer<typeof liveHealthSchema>;
export type ReadyHealth = z.infer<typeof readyHealthSchema>;
export type MetricOutcomes = z.infer<typeof metricOutcomesSchema>;
export type MetricDurationSummary = z.infer<typeof metricDurationSummarySchema>;
export type MetricAggregate = z.infer<typeof metricAggregateSchema>;
export type MetricsBucket = z.infer<typeof metricsBucketSchema>;
export type OperationMetrics = z.infer<typeof operationMetricsSchema>;
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type Hub = z.infer<typeof hubSchema>;
export type HubCatalog = z.infer<typeof hubCatalogSchema>;
export type HubCounts = z.infer<typeof hubCountsSchema>;
export type HubMember = z.infer<typeof hubMemberSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type ToolCallInput = z.infer<typeof toolCallInputSchema>;
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;
export type ReadResourceInput = z.infer<typeof readResourceInputSchema>;
export type ReadResourceResult = z.infer<typeof readResourceResultSchema>;
export type GetPromptInput = z.infer<typeof getPromptInputSchema>;
export type PromptMessage = z.infer<typeof promptMessageSchema>;
export type GetPromptResult = z.infer<typeof getPromptResultSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type ResourceTemplate = z.infer<typeof resourceTemplateSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export type Probe = z.infer<typeof probeSchema>;
export type ConnectionDraft = z.infer<typeof connectionDraftSchema>;
export type ConnectionUpdate = z.infer<typeof connectionUpdateSchema>;
export type DesiredConnectionState = Connection["desiredState"];
export type ConformanceRunStatus = z.infer<typeof conformanceRunStatusSchema>;
export type ConformanceReport = z.infer<typeof conformanceReportSchema>;
export type ConformanceRun = z.infer<typeof conformanceRunSchema>;
export type ConformanceRunView = ConformanceRun;

export class ControlPlaneApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[];

  constructor(
    status: number,
    code: string,
    message: string,
    details: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlPlaneApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
}

// A replacement can drain an operation, close the old runtime, and connect the new generation.
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const configuredRequestTimeout = Number(
  process.env.NEXT_PUBLIC_CONTROL_PLANE_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
);
const REQUEST_TIMEOUT_MS =
  Number.isSafeInteger(configuredRequestTimeout) &&
  configuredRequestTimeout >= 1_000 &&
  configuredRequestTimeout <= 600_000
    ? configuredRequestTimeout
    : DEFAULT_REQUEST_TIMEOUT_MS;

function requestSignal(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === null || signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function requestJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  options: RequestOptions = {},
): Promise<z.output<Schema>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      signal: requestSignal(options.signal),
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new ControlPlaneApiError(
      0,
      "NETWORK_ERROR",
      "The control-plane API could not be reached.",
      [],
      { cause },
    );
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(payload);
    if (problem.success) {
      throw new ControlPlaneApiError(
        problem.data.statusCode,
        problem.data.code,
        problem.data.message,
        problem.data.details ?? [],
      );
    }
    throw new ControlPlaneApiError(
      response.status,
      "HTTP_ERROR",
      `The control-plane API returned HTTP ${String(response.status)}.`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlPlaneApiError(
      response.status,
      "INVALID_RESPONSE",
      "The control-plane API returned an unexpected response.",
      parsed.error.issues.map((issue) => issue.path.join(".") || issue.message),
    );
  }
  return parsed.data;
}

async function requestEmpty(path: string, options: Omit<RequestInit, "body">): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      signal: requestSignal(options.signal),
      headers: {
        Accept: "application/json",
        ...options.headers,
      },
    });
  } catch (cause) {
    throw new ControlPlaneApiError(
      0,
      "NETWORK_ERROR",
      "The control-plane API could not be reached.",
      [],
      { cause },
    );
  }

  if (response.ok) return;
  const payload = await readJson(response);
  const problem = problemDetailsSchema.safeParse(payload);
  if (problem.success) {
    throw new ControlPlaneApiError(
      problem.data.statusCode,
      problem.data.code,
      problem.data.message,
      problem.data.details ?? [],
    );
  }
  throw new ControlPlaneApiError(
    response.status,
    "HTTP_ERROR",
    `The control-plane API returned HTTP ${String(response.status)}.`,
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function connectionPath(connectionId: string): string {
  return `/v1/mcp/connections/${encodeURIComponent(connectionId)}`;
}

export function oauthAuthorizationPath(connectionId: string, expectedRevision: number): string {
  const params = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  return `/api${connectionPath(connectionId)}/oauth/authorize?${params.toString()}`;
}

function hubMemberPath(connectionId: string): string {
  return `/v1/mcp/hub/members/${encodeURIComponent(connectionId)}`;
}

function conformanceRunPath(runId: string): string {
  return `/v1/mcp/conformance/runs/${encodeURIComponent(runId)}`;
}

export const controlPlaneApi = {
  listConnections(signal?: AbortSignal): Promise<Connection[]> {
    return requestJson("/v1/mcp/connections", connectionsSchema, { signal });
  },

  runtimeSnapshot(signal?: AbortSignal): Promise<RuntimeManager> {
    return requestJson("/v1/mcp/runtime", runtimeManagerSchema, { signal });
  },

  liveHealth(signal?: AbortSignal): Promise<LiveHealth> {
    return requestJson("/health/live", liveHealthSchema, { signal });
  },

  readyHealth(signal?: AbortSignal): Promise<ReadyHealth> {
    return requestJson("/health/ready", readyHealthSchema, { signal });
  },

  metricsSnapshot(signal?: AbortSignal): Promise<MetricsSnapshot> {
    return requestJson("/v1/mcp/metrics", metricsSnapshotSchema, { signal });
  },

  startConformanceRun(connection: Pick<Connection, "id" | "revision" | "runtimeGeneration">) {
    return requestJson("/v1/mcp/conformance/runs", conformanceRunSchema, {
      method: "POST",
      body: {
        target: {
          kind: "connection",
          connectionId: connection.id,
          expectedRevision: connection.revision,
          runtimeGeneration: connection.runtimeGeneration,
        },
      },
    });
  },

  listConformanceRuns(
    connectionId: string,
    runtimeGeneration: number,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<ConformanceRun[]> {
    const params = new URLSearchParams({
      connectionId,
      runtimeGeneration: String(runtimeGeneration),
      limit: String(limit),
    });
    return requestJson(`/v1/mcp/conformance/runs?${params.toString()}`, conformanceRunsSchema, {
      signal,
    }).then((response) => response.runs);
  },

  getConformanceRun(runId: string, signal?: AbortSignal): Promise<ConformanceRun> {
    return requestJson(conformanceRunPath(runId), conformanceRunSchema, { signal });
  },

  cancelConformanceRun(runId: string): Promise<ConformanceRun> {
    return requestJson(`${conformanceRunPath(runId)}/cancel`, conformanceRunSchema, {
      method: "POST",
    });
  },

  hubSnapshot(signal?: AbortSignal): Promise<Hub> {
    return requestJson("/v1/mcp/hub", hubSchema, { signal });
  },

  getHubCatalog(expectedHubRevision: number, signal?: AbortSignal): Promise<HubCatalog> {
    const params = new URLSearchParams({ expectedHubRevision: String(expectedHubRevision) });
    return requestJson(`/v1/mcp/hub/catalog?${params.toString()}`, hubCatalogSchema, { signal });
  },

  attachHubMember(input: {
    readonly connectionId: string;
    readonly namespace: string;
    readonly expectedHubRevision: number;
    readonly expectedConnectionRevision: number;
    readonly runtimeGeneration: number;
  }): Promise<Hub> {
    return requestJson(hubMemberPath(input.connectionId), hubSchema, {
      method: "PUT",
      body: {
        namespace: input.namespace,
        expectedHubRevision: input.expectedHubRevision,
        expectedConnectionRevision: input.expectedConnectionRevision,
        runtimeGeneration: input.runtimeGeneration,
      },
    });
  },

  detachHubMember(
    connectionId: string,
    expectedHubRevision: number,
    runtimeGeneration: number,
  ): Promise<void> {
    const params = new URLSearchParams({
      expectedHubRevision: String(expectedHubRevision),
      runtimeGeneration: String(runtimeGeneration),
    });
    return requestEmpty(`${hubMemberPath(connectionId)}?${params.toString()}`, {
      method: "DELETE",
    });
  },

  refreshHubCatalog(expectedHubRevision: number): Promise<Hub> {
    return requestJson("/v1/mcp/hub/catalog/refresh", hubSchema, {
      method: "POST",
      body: { expectedHubRevision },
    });
  },

  createConnection(
    draft: ConnectionDraft & { readonly desiredState: DesiredConnectionState },
  ): Promise<Connection> {
    return requestJson("/v1/mcp/connections", connectionSchema, {
      method: "POST",
      body: draft,
    });
  },

  replaceConnection(
    connectionId: string,
    expectedRevision: number,
    draft: ConnectionUpdate,
  ): Promise<Connection> {
    return requestJson(connectionPath(connectionId), connectionSchema, {
      method: "PUT",
      body: { expectedRevision, ...draft },
    });
  },

  setDesiredState(
    connectionId: string,
    expectedRevision: number,
    state: DesiredConnectionState,
  ): Promise<Connection> {
    return requestJson(`${connectionPath(connectionId)}/desired-state`, connectionSchema, {
      method: "PUT",
      body: { expectedRevision, state },
    });
  },

  deleteConnection(connectionId: string, expectedRevision: number): Promise<void> {
    const params = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return requestEmpty(`${connectionPath(connectionId)}?${params.toString()}`, {
      method: "DELETE",
    });
  },

  probeConnection(connectionId: string): Promise<Probe> {
    return requestJson(`${connectionPath(connectionId)}/probe`, probeSchema, {
      method: "POST",
    });
  },

  getCatalog(connectionId: string, signal?: AbortSignal): Promise<Catalog> {
    return requestJson(`${connectionPath(connectionId)}/catalog`, catalogSchema, { signal });
  },

  refreshCatalog(connectionId: string): Promise<Catalog> {
    return requestJson(`${connectionPath(connectionId)}/catalog/refresh`, catalogSchema, {
      method: "POST",
    });
  },

  callTool(connectionId: string, input: ToolCallInput): Promise<ToolCallResult> {
    return requestJson(`${connectionPath(connectionId)}/tools/call`, toolCallResultSchema, {
      method: "POST",
      body: input,
    });
  },

  readResource(connectionId: string, input: ReadResourceInput): Promise<ReadResourceResult> {
    return requestJson(`${connectionPath(connectionId)}/resources/read`, readResourceResultSchema, {
      method: "POST",
      body: input,
    });
  },

  getPrompt(connectionId: string, input: GetPromptInput): Promise<GetPromptResult> {
    return requestJson(`${connectionPath(connectionId)}/prompts/get`, getPromptResultSchema, {
      method: "POST",
      body: input,
    });
  },
};

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ControlPlaneApiError) {
    return error.details.length === 0
      ? error.message
      : `${error.message} ${error.details.join(" ")}`;
  }
  return "The request could not be completed.";
}
