import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type { ConformanceRunStatus } from "./conformance.types.ts";

const runStatuses = [
	"queued",
	"running",
	"cancelling",
	"completed",
	"cancelled",
	"timed-out",
	"failed",
] as const;

class ConformanceRunTargetResponseDto {
	@ApiProperty({ enum: ["connection"] })
	kind!: "connection";

	@ApiProperty({ format: "uuid" })
	connectionId!: string;

	@ApiProperty({ minimum: 1 })
	expectedRevision!: number;

	@ApiProperty({ minimum: 1 })
	runtimeGeneration!: number;
}

class ConformanceReportTargetResponseDto {
	@ApiProperty()
	kind!: string;

	@ApiProperty()
	id!: string;

	@ApiPropertyOptional({ minimum: 1 })
	revision?: number;

	@ApiPropertyOptional({ minimum: 1 })
	generation?: number;
}

class ConformanceReportSubjectResponseDto {
	@ApiProperty()
	name!: string;

	@ApiProperty()
	version!: string;

	@ApiPropertyOptional()
	revision?: string;
}

class ConformanceReportDescriptorResponseDto {
	@ApiProperty({ type: () => ConformanceReportTargetResponseDto })
	target!: ConformanceReportTargetResponseDto;

	@ApiProperty({ type: () => ConformanceReportSubjectResponseDto })
	subject!: ConformanceReportSubjectResponseDto;

	@ApiPropertyOptional()
	fixtureVersion?: string;
}

class ConformancePlanCheckResponseDto {
	@ApiProperty()
	id!: string;

	@ApiProperty()
	title!: string;

	@ApiProperty({ enum: ["read-only", "side-effecting"] })
	risk!: "read-only" | "side-effecting";
}

class ConformancePlanResponseDto {
	@ApiProperty()
	id!: string;

	@ApiProperty()
	version!: string;

	@ApiProperty()
	title!: string;

	@ApiProperty({ example: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
	digest!: string;

	@ApiProperty({ type: () => ConformancePlanCheckResponseDto, isArray: true })
	checks!: readonly ConformancePlanCheckResponseDto[];
}

class ConformanceCountsResponseDto {
	@ApiProperty({ minimum: 0 })
	pass!: number;

	@ApiProperty({ minimum: 0 })
	warn!: number;

	@ApiProperty({ minimum: 0 })
	fail!: number;

	@ApiProperty({ minimum: 0 })
	skip!: number;

	@ApiProperty({ minimum: 0 })
	error!: number;
}

class ConformanceCheckResponseDto {
	@ApiProperty()
	id!: string;

	@ApiProperty()
	title!: string;

	@ApiProperty({ enum: ["read-only", "side-effecting"] })
	risk!: "read-only" | "side-effecting";

	@ApiProperty({ enum: ["pass", "warn", "fail", "skip", "error"] })
	status!: "pass" | "warn" | "fail" | "skip" | "error";

	@ApiProperty()
	code!: string;

	@ApiProperty({ minimum: 0 })
	durationMs!: number;

	@ApiProperty({
		type: "object",
		additionalProperties: {
			oneOf: [
				{ type: "string" },
				{ type: "number" },
				{ type: "boolean" },
				{ type: "string", nullable: true, enum: [null] },
			],
		},
	})
	facts!: Readonly<Record<string, string | number | boolean | null>>;

	@ApiProperty({ minimum: 0 })
	factsOmittedCount!: number;
}

class ConformanceReportResponseDto {
	@ApiProperty({ enum: [1] })
	reportSchemaVersion!: 1;

	@ApiProperty({ enum: [1] })
	fingerprintVersion!: 1;

	@ApiProperty()
	runId!: string;

	@ApiProperty({ type: () => ConformancePlanResponseDto })
	plan!: ConformancePlanResponseDto;

	@ApiProperty({ type: () => ConformanceReportDescriptorResponseDto })
	descriptor!: ConformanceReportDescriptorResponseDto;

	@ApiProperty({ format: "date-time" })
	startedAt!: string;

	@ApiProperty({ format: "date-time" })
	finishedAt!: string;

	@ApiProperty({ minimum: 0 })
	durationMs!: number;

	@ApiProperty({ enum: ["completed", "cancelled", "timed-out"] })
	completion!: "completed" | "cancelled" | "timed-out";

	@ApiProperty({ enum: ["pass", "warn", "fail", "inconclusive"] })
	verdict!: "pass" | "warn" | "fail" | "inconclusive";

	@ApiProperty({ type: () => ConformanceCountsResponseDto })
	counts!: ConformanceCountsResponseDto;

	@ApiProperty({ type: () => ConformanceCheckResponseDto, isArray: true })
	checks!: readonly ConformanceCheckResponseDto[];
}

export class ConformanceRunResponseDto {
	@ApiProperty({ format: "uuid" })
	runId!: string;

	@ApiProperty({ enum: ["safe-discovery-v1"] })
	planId!: "safe-discovery-v1";

	@ApiProperty({ type: () => ConformanceRunTargetResponseDto })
	target!: ConformanceRunTargetResponseDto;

	@ApiProperty({ enum: runStatuses })
	status!: ConformanceRunStatus;

	@ApiProperty({ format: "date-time" })
	createdAt!: string;

	@ApiPropertyOptional({ format: "date-time" })
	startedAt?: string;

	@ApiPropertyOptional({ format: "date-time" })
	finishedAt?: string;

	@ApiPropertyOptional()
	errorCode?: string;

	@ApiPropertyOptional({ type: () => ConformanceReportResponseDto })
	report?: ConformanceReportResponseDto;
}

export class ConformanceRunListResponseDto {
	@ApiProperty({ type: () => ConformanceRunResponseDto, isArray: true, maxItems: 100 })
	runs!: readonly ConformanceRunResponseDto[];
}
