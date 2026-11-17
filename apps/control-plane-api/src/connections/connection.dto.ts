import { createStandardSchemaDto } from "../common/standard-schema-dto.ts";
import { z } from "zod";

import type { ConnectionAuthenticationKind, DesiredConnectionState } from "./connection.types.ts";

const MAX_PROMPT_ARGUMENTS = 64;
const MAX_PROMPT_ARGUMENT_NAME_CHARACTERS = 200;
const MAX_PROMPT_ARGUMENT_VALUE_CHARACTERS = 16 * 1_024;
const MAX_PROMPT_ARGUMENT_JSON_BYTES = 64 * 1_024;

const authenticationKinds = [
	"none",
	"oauth",
] as const satisfies readonly ConnectionAuthenticationKind[];
const desiredConnectionStates = [
	"offline",
	"online",
] as const satisfies readonly DesiredConnectionState[];

const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const httpEndpointSchema = z
	.url({ protocol: /^https?$/ })
	.meta({ example: "http://127.0.0.1:3200/mcp" });
const promptArgumentsSchema = z
	.record(
		z.string().min(1).max(MAX_PROMPT_ARGUMENT_NAME_CHARACTERS),
		z.string().max(MAX_PROMPT_ARGUMENT_VALUE_CHARACTERS),
	)
	.superRefine((arguments_, context) => {
		if (Object.keys(arguments_).length > MAX_PROMPT_ARGUMENTS) {
			context.addIssue({
				code: "custom",
				message: `Arguments must contain at most ${String(MAX_PROMPT_ARGUMENTS)} values.`,
			});
		}
		if (
			new TextEncoder().encode(JSON.stringify(arguments_)).byteLength >
			MAX_PROMPT_ARGUMENT_JSON_BYTES
		) {
			context.addIssue({
				code: "custom",
				message: "Arguments must fit within 64 KiB.",
			});
		}
	})
	.meta({
		description: "At most 64 string arguments with a total serialized size of 64 KiB.",
		maxProperties: MAX_PROMPT_ARGUMENTS,
	});

export const ConnectionAuthenticationSchema = z.strictObject({
	kind: z.enum(authenticationKinds),
});

export class ConnectionAuthenticationDto extends createStandardSchemaDto(
	ConnectionAuthenticationSchema,
) {}

export const CreateConnectionSchema = z.strictObject({
	displayName: z.string().trim().min(1).max(120),
	endpoint: httpEndpointSchema,
	desiredState: z.enum(desiredConnectionStates).optional().meta({ default: "offline" }),
	authentication: ConnectionAuthenticationSchema.optional().meta({
		default: { kind: "none" },
	}),
});

export class CreateConnectionDto extends createStandardSchemaDto(CreateConnectionSchema) {}

export const ReplaceConnectionSchema = z.strictObject({
	expectedRevision: positiveSafeIntegerSchema,
	displayName: z.string().trim().min(1).max(120),
	endpoint: httpEndpointSchema.optional().meta({
		description: "Omit to preserve the currently admitted endpoint and runtime generation.",
		example: "http://127.0.0.1:3200/mcp",
	}),
});

export class ReplaceConnectionDto extends createStandardSchemaDto(ReplaceConnectionSchema) {}

export const SetDesiredStateSchema = z.strictObject({
	expectedRevision: positiveSafeIntegerSchema,
	state: z.enum(desiredConnectionStates),
});

export class SetDesiredStateDto extends createStandardSchemaDto(SetDesiredStateSchema) {}

export const CallToolSchema = z.strictObject({
	name: z.string().min(1).max(200),
	arguments: z.record(z.string(), z.unknown()).optional(),
});

export class CallToolDto extends createStandardSchemaDto(CallToolSchema) {}

export const ReadResourceSchema = z.strictObject({
	uri: z.string().min(1).max(4_096),
});

export class ReadResourceDto extends createStandardSchemaDto(ReadResourceSchema) {}

export const GetPromptSchema = z.strictObject({
	name: z.string().min(1).max(200),
	arguments: promptArgumentsSchema.optional(),
});

export class GetPromptDto extends createStandardSchemaDto(GetPromptSchema) {}
