import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	MCP_METRICS_BUCKET_COUNT,
	MCP_METRICS_MAX_OPERATION_GROUPS,
} from "@nest-mcp/observability";

const maximumCount = Number.MAX_SAFE_INTEGER;

export class McpMetricOutcomesResponseDto {
	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	success!: number;

	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	error!: number;

	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	cancelled!: number;
}

export class McpMetricDurationResponseDto {
	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	count!: number;

	@ApiProperty({ maximum: maximumCount, minimum: 0, nullable: true, type: Number })
	averageMs!: number | null;

	@ApiProperty({ maximum: maximumCount, minimum: 0, nullable: true, type: Number })
	p50Ms!: number | null;

	@ApiProperty({ maximum: maximumCount, minimum: 0, nullable: true, type: Number })
	p95Ms!: number | null;

	@ApiProperty({ maximum: maximumCount, minimum: 0, nullable: true, type: Number })
	maxMs!: number | null;
}

export class McpMetricAggregateResponseDto {
	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	started!: number;

	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	active!: number;

	@ApiProperty({ type: () => McpMetricOutcomesResponseDto })
	outcomes!: McpMetricOutcomesResponseDto;

	@ApiProperty({ type: () => McpMetricDurationResponseDto })
	duration!: McpMetricDurationResponseDto;
}

export class McpMetricBucketResponseDto {
	@ApiProperty({ format: "date-time" })
	startedAt!: string;

	@ApiProperty({ maximum: maximumCount, minimum: 0 })
	started!: number;

	@ApiProperty({ type: () => McpMetricOutcomesResponseDto })
	outcomes!: McpMetricOutcomesResponseDto;

	@ApiProperty({ type: () => McpMetricDurationResponseDto })
	duration!: McpMetricDurationResponseDto;
}

export class McpMetricWindowResponseDto {
	@ApiProperty({ maximum: 300, minimum: 1 })
	bucketSeconds!: number;

	@ApiProperty({
		isArray: true,
		maxItems: MCP_METRICS_BUCKET_COUNT,
		type: () => McpMetricBucketResponseDto,
	})
	buckets!: readonly McpMetricBucketResponseDto[];
}

export class McpMetricOperationResponseDto extends McpMetricAggregateResponseDto {
	@ApiProperty({ enum: ["client", "server", "gateway"] })
	role!: "client" | "server" | "gateway";

	@ApiProperty({ maxLength: 128, minLength: 1 })
	name!: string;

	@ApiProperty({ enum: ["request", "notification"] })
	kind!: "request" | "notification";

	@ApiPropertyOptional({ maxLength: 128, minLength: 1 })
	capability?: string;
}

export class McpMetricsSnapshotResponseDto {
	@ApiProperty({ enum: ["process"] })
	scope!: "process";

	@ApiProperty({ format: "date-time" })
	startedAt!: string;

	@ApiProperty({ format: "date-time" })
	capturedAt!: string;

	@ApiProperty({ type: () => McpMetricAggregateResponseDto })
	totals!: McpMetricAggregateResponseDto;

	@ApiProperty({ type: () => McpMetricWindowResponseDto })
	window!: McpMetricWindowResponseDto;

	@ApiProperty({
		isArray: true,
		maxItems: MCP_METRICS_MAX_OPERATION_GROUPS,
		type: () => McpMetricOperationResponseDto,
	})
	operations!: readonly McpMetricOperationResponseDto[];

	@ApiProperty()
	operationsTruncated!: boolean;
}
