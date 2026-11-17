import { ApiProperty } from "@nestjs/swagger";

import { RuntimeStateResponseDto } from "../connections/connection.response.ts";

class HubEndpointResponseDto {
	@ApiProperty({ enum: ["streamable-http"] })
	transport!: "streamable-http";

	@ApiProperty({ enum: ["/mcp/hub"] })
	path!: "/mcp/hub";
}

class HubCountsResponseDto {
	@ApiProperty({ minimum: 0 })
	tools!: number;

	@ApiProperty({ minimum: 0 })
	resources!: number;

	@ApiProperty({ minimum: 0 })
	resourceTemplates!: number;

	@ApiProperty({ minimum: 0 })
	prompts!: number;
}

class HubMemberRuntimeResponseDto {
	@ApiProperty({
		enum: [
			"offline",
			"queued",
			"connecting",
			"online",
			"degraded",
			"draining",
			"failed",
			"quarantined",
		],
	})
	phase!: RuntimeStateResponseDto["phase"];
}

export class HubMemberResponseDto {
	@ApiProperty({ format: "uuid" })
	connectionId!: string;

	@ApiProperty({ minimum: 1 })
	connectionRevision!: number;

	@ApiProperty({ minimum: 1 })
	runtimeGeneration!: number;

	@ApiProperty({ maxLength: 32 })
	namespace!: string;

	@ApiProperty({ maxLength: 120 })
	displayName!: string;

	@ApiProperty({ format: "date-time" })
	attachedAt!: string;

	@ApiProperty({ type: () => HubMemberRuntimeResponseDto })
	runtime!: HubMemberRuntimeResponseDto;
}

export class HubResponseDto {
	@ApiProperty({ minimum: 1 })
	revision!: number;

	@ApiProperty({ format: "date-time" })
	updatedAt!: string;

	@ApiProperty({ type: () => HubEndpointResponseDto })
	endpoint!: HubEndpointResponseDto;

	@ApiProperty({ type: () => HubMemberResponseDto, isArray: true })
	members!: readonly HubMemberResponseDto[];

	@ApiProperty({ type: () => HubCountsResponseDto })
	counts!: HubCountsResponseDto;
}

class HubCatalogToolResponseDto {
	@ApiProperty({ maxLength: 32 })
	namespace!: string;

	@ApiProperty()
	sourceName!: string;

	@ApiProperty()
	projectedName!: string;

	@ApiProperty({ type: "object", additionalProperties: true })
	definition!: Record<string, unknown>;
}

class HubCatalogResourceResponseDto extends HubCatalogToolResponseDto {
	@ApiProperty({ format: "uri" })
	projectedUri!: string;
}

class HubCatalogResourceTemplateResponseDto extends HubCatalogToolResponseDto {
	@ApiProperty()
	projectedUriTemplate!: string;
}

export class HubCatalogResponseDto {
	@ApiProperty({ minimum: 1 })
	revision!: number;

	@ApiProperty({ format: "date-time" })
	publishedAt!: string;

	@ApiProperty({ type: () => HubCatalogToolResponseDto, isArray: true })
	tools!: readonly HubCatalogToolResponseDto[];

	@ApiProperty({ type: () => HubCatalogResourceResponseDto, isArray: true })
	resources!: readonly HubCatalogResourceResponseDto[];

	@ApiProperty({ type: () => HubCatalogResourceTemplateResponseDto, isArray: true })
	resourceTemplates!: readonly HubCatalogResourceTemplateResponseDto[];

	@ApiProperty({ type: () => HubCatalogToolResponseDto, isArray: true })
	prompts!: readonly HubCatalogToolResponseDto[];
}
