import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";

const runtimePhases = [
	"offline",
	"queued",
	"connecting",
	"online",
	"degraded",
	"draining",
	"failed",
	"quarantined",
] as const;

export class RuntimeCapabilitiesResponseDto {
	@ApiProperty()
	tools!: boolean;

	@ApiProperty()
	resources!: boolean;

	@ApiProperty()
	prompts!: boolean;

	@ApiProperty()
	completion!: boolean;

	@ApiProperty()
	subscriptions!: boolean;
}

export class RuntimeStateResponseDto {
	@ApiProperty({ enum: runtimePhases })
	phase!: (typeof runtimePhases)[number];

	@ApiProperty({ format: "date-time" })
	lastTransitionAt!: string;

	@ApiPropertyOptional()
	protocolVersion?: string;

	@ApiPropertyOptional()
	protocolEra?: string;

	@ApiPropertyOptional({ format: "date-time" })
	connectedAt?: string;

	@ApiPropertyOptional()
	errorCode?: string;

	@ApiPropertyOptional({ type: () => RuntimeCapabilitiesResponseDto })
	capabilities?: RuntimeCapabilitiesResponseDto;
}

class ConnectionTransportResponseDto {
	@ApiProperty({ enum: ["http"] })
	kind!: "http";

	@ApiProperty({ example: "127.0.0.1:3200" })
	host!: string;
}

class ConnectionAuthenticationResponseDto {
	@ApiProperty({ enum: ["none"] })
	kind!: "none";

	@ApiProperty({ example: true })
	configured!: true;
}

const oauthAuthenticationStatuses = [
	"authorization-required",
	"authorizing",
	"authorized",
	"reauthorization-required",
	"failed",
] as const;

class ConnectionOAuthAuthenticationResponseDto {
	@ApiProperty({ enum: ["oauth"] })
	kind!: "oauth";

	@ApiProperty({ enum: oauthAuthenticationStatuses })
	status!: (typeof oauthAuthenticationStatuses)[number];

	@ApiProperty({ type: [String], maxItems: 64 })
	scopes!: readonly string[];

	@ApiPropertyOptional({ example: "login.example.com" })
	authorizationServerHost?: string;

	@ApiPropertyOptional({ example: "MCP_OAUTH_AUTHORIZATION_REQUIRED" })
	errorCode?: string;
}

@ApiExtraModels(ConnectionAuthenticationResponseDto, ConnectionOAuthAuthenticationResponseDto)
export class ConnectionResponseDto {
	@ApiProperty({ format: "uuid" })
	id!: string;

	@ApiProperty({ minimum: 1 })
	revision!: number;

	@ApiProperty({ minimum: 1 })
	runtimeGeneration!: number;

	@ApiProperty({ maxLength: 120 })
	displayName!: string;

	@ApiProperty({ enum: ["offline", "online"] })
	desiredState!: "offline" | "online";

	@ApiProperty()
	deletionPending!: boolean;

	@ApiProperty({ format: "date-time" })
	createdAt!: string;

	@ApiProperty({ format: "date-time" })
	updatedAt!: string;

	@ApiProperty({ type: () => ConnectionTransportResponseDto })
	transport!: ConnectionTransportResponseDto;

	@ApiProperty({
		oneOf: [
			{ $ref: getSchemaPath(ConnectionAuthenticationResponseDto) },
			{ $ref: getSchemaPath(ConnectionOAuthAuthenticationResponseDto) },
		],
	})
	authentication!: ConnectionAuthenticationResponseDto | ConnectionOAuthAuthenticationResponseDto;

	@ApiProperty({ type: () => RuntimeStateResponseDto })
	runtime!: RuntimeStateResponseDto;
}

export class RuntimeManagerResponseDto {
	@ApiProperty()
	closed!: boolean;

	@ApiProperty({ minimum: 1 })
	maxConnections!: number;

	@ApiProperty({ minimum: 0 })
	connectionCount!: number;

	@ApiProperty({ minimum: 0 })
	pendingConnectionCount!: number;

	@ApiProperty({ minimum: 0 })
	activeConnectionCount!: number;

	@ApiProperty({ minimum: 0 })
	closingConnectionCount!: number;

	@ApiProperty({ minimum: 0 })
	quarantinedConnectionCount!: number;

	@ApiProperty({ minimum: 0 })
	operationReferenceCount!: number;

	@ApiProperty({ minimum: 0 })
	onlineKeeperCount!: number;
}

export class CatalogResponseDto {
	@ApiProperty({ format: "uuid" })
	connectionId!: string;

	@ApiProperty({ minimum: 1 })
	runtimeGeneration!: number;

	@ApiProperty({ format: "date-time" })
	discoveredAt!: string;

	@ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
	tools!: readonly Record<string, unknown>[];

	@ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
	resources!: readonly Record<string, unknown>[];

	@ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
	resourceTemplates!: readonly Record<string, unknown>[];

	@ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
	prompts!: readonly Record<string, unknown>[];
}

export class ProbeResponseDto {
	@ApiProperty({ example: true })
	reachable!: true;

	@ApiProperty({ format: "date-time" })
	observedAt!: string;

	@ApiPropertyOptional()
	protocolVersion?: string;

	@ApiPropertyOptional()
	protocolEra?: string;

	@ApiPropertyOptional({ type: () => RuntimeCapabilitiesResponseDto })
	capabilities?: RuntimeCapabilitiesResponseDto;

	@ApiProperty({ type: () => RuntimeStateResponseDto })
	runtime!: RuntimeStateResponseDto;
}
