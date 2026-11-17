import { createStandardSchemaDto } from "../common/standard-schema-dto.ts";
import { z } from "zod";

export const HUB_NAMESPACE_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const queryPositiveSafeIntegerSchema = z
	.string()
	.regex(/^[1-9]\d*$/)
	.transform(Number)
	.pipe(positiveSafeIntegerSchema);

export const AttachHubMemberSchema = z.strictObject({
	namespace: z.string().trim().regex(HUB_NAMESPACE_PATTERN).meta({ example: "deepwiki" }),
	expectedHubRevision: positiveSafeIntegerSchema,
	expectedConnectionRevision: positiveSafeIntegerSchema,
	runtimeGeneration: positiveSafeIntegerSchema,
});

export class AttachHubMemberDto extends createStandardSchemaDto(AttachHubMemberSchema) {}

export const DetachHubMemberQuerySchema = z.strictObject({
	expectedHubRevision: queryPositiveSafeIntegerSchema,
	runtimeGeneration: queryPositiveSafeIntegerSchema,
});

export class DetachHubMemberQueryDto extends createStandardSchemaDto(DetachHubMemberQuerySchema) {}

export const HubCatalogQuerySchema = z.strictObject({
	expectedHubRevision: queryPositiveSafeIntegerSchema.optional(),
});

export class HubCatalogQueryDto extends createStandardSchemaDto(HubCatalogQuerySchema) {}

export const RefreshHubCatalogSchema = z.strictObject({
	expectedHubRevision: positiveSafeIntegerSchema,
});

export class RefreshHubCatalogDto extends createStandardSchemaDto(RefreshHubCatalogSchema) {}
