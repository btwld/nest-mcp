import { createStandardSchemaDto } from "../common/standard-schema-dto.ts";
import { z } from "zod";

const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const queryPositiveSafeIntegerSchema = z
	.string()
	.regex(/^[1-9]\d*$/u)
	.transform(Number)
	.pipe(positiveSafeIntegerSchema);

export const CreateConformanceRunSchema = z.strictObject({
	target: z.strictObject({
		kind: z.literal("connection"),
		connectionId: z.string().uuid(),
		expectedRevision: positiveSafeIntegerSchema,
		runtimeGeneration: positiveSafeIntegerSchema,
	}),
});

export class CreateConformanceRunDto extends createStandardSchemaDto(CreateConformanceRunSchema) {}

export const ListConformanceRunsQuerySchema = z.strictObject({
	connectionId: z.string().uuid(),
	runtimeGeneration: queryPositiveSafeIntegerSchema,
	limit: queryPositiveSafeIntegerSchema.pipe(z.number().max(100)).default(20),
});

export class ListConformanceRunsQueryDto extends createStandardSchemaDto(
	ListConformanceRunsQuerySchema,
) {}
