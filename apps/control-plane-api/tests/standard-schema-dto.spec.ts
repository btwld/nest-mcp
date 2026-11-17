import { getStandardSchema, isStandardSchemaDto } from "../src/common/standard-schema-dto.ts";
import { describe, expect, it } from "vitest";

import {
	CallToolDto,
	CallToolSchema,
	ConnectionAuthenticationDto,
	ConnectionAuthenticationSchema,
	CreateConnectionDto,
	CreateConnectionSchema,
	GetPromptDto,
	GetPromptSchema,
	ReadResourceDto,
	ReadResourceSchema,
	ReplaceConnectionDto,
	ReplaceConnectionSchema,
	SetDesiredStateDto,
	SetDesiredStateSchema,
} from "../src/connections/connection.dto.ts";
import {
	CreateConformanceRunDto,
	CreateConformanceRunSchema,
	ListConformanceRunsQueryDto,
	ListConformanceRunsQuerySchema,
} from "../src/conformance/conformance.dto.ts";
import {
	AttachHubMemberDto,
	AttachHubMemberSchema,
	DetachHubMemberQueryDto,
	DetachHubMemberQuerySchema,
	HubCatalogQueryDto,
	HubCatalogQuerySchema,
	RefreshHubCatalogDto,
	RefreshHubCatalogSchema,
} from "../src/hub/hub.dto.ts";

describe("control-plane Standard Schema DTOs", () => {
	it("carries each Zod schema through the Standard Schema DTO factory", () => {
		for (const [dto, schema] of [
			[ConnectionAuthenticationDto, ConnectionAuthenticationSchema],
			[CreateConnectionDto, CreateConnectionSchema],
			[ReplaceConnectionDto, ReplaceConnectionSchema],
			[SetDesiredStateDto, SetDesiredStateSchema],
			[CallToolDto, CallToolSchema],
			[ReadResourceDto, ReadResourceSchema],
			[GetPromptDto, GetPromptSchema],
			[CreateConformanceRunDto, CreateConformanceRunSchema],
			[ListConformanceRunsQueryDto, ListConformanceRunsQuerySchema],
			[AttachHubMemberDto, AttachHubMemberSchema],
			[DetachHubMemberQueryDto, DetachHubMemberQuerySchema],
			[HubCatalogQueryDto, HubCatalogQuerySchema],
			[RefreshHubCatalogDto, RefreshHubCatalogSchema],
		] as const) {
			expect(isStandardSchemaDto(dto)).toBe(true);
			expect(getStandardSchema(dto)).toBe(schema);
			expect(dto.schema["~standard"].vendor).toBe("zod");
		}
	});

	it("trims display names and strictly rejects unknown keys and endpoint schemes", async () => {
		expect(
			await CreateConnectionDto.schema["~standard"].validate({
				displayName: "  Local fixture  ",
				endpoint: "http://127.0.0.1:3200/mcp",
			}),
		).toEqual({
			value: {
				displayName: "Local fixture",
				endpoint: "http://127.0.0.1:3200/mcp",
			},
		});

		for (const input of [
			{
				displayName: "Fixture",
				endpoint: "http://127.0.0.1/mcp",
				unexpected: true,
			},
			{
				authentication: { kind: "none", unexpected: true },
				displayName: "Fixture",
				endpoint: "http://127.0.0.1/mcp",
			},
			{ displayName: "Fixture", endpoint: "ftp://example.com/mcp" },
		]) {
			const result = await CreateConnectionDto.schema["~standard"].validate(input);
			expect(result).toHaveProperty("issues");
		}
	});

	it("only accepts singular string revision query values before transforming them", async () => {
		expect(
			await HubCatalogQueryDto.schema["~standard"].validate({ expectedHubRevision: "42" }),
		).toEqual({ value: { expectedHubRevision: 42 } });

		for (const expectedHubRevision of [42, ["42"], ["41", "42"], "1.5", "1e2"]) {
			const result = await HubCatalogQueryDto.schema["~standard"].validate({
				expectedHubRevision,
			});
			expect(result).toHaveProperty("issues");
		}
	});

	it("strictly validates generation-fenced conformance inputs", async () => {
		const connectionId = "8589b4f6-6a4d-4610-9c5f-bf46f6471629";
		expect(
			await CreateConformanceRunDto.schema["~standard"].validate({
				target: {
					kind: "connection",
					connectionId,
					expectedRevision: 2,
					runtimeGeneration: 3,
				},
			}),
		).toEqual({
			value: {
				target: {
					kind: "connection",
					connectionId,
					expectedRevision: 2,
					runtimeGeneration: 3,
				},
			},
		});
		expect(
			await ListConformanceRunsQueryDto.schema["~standard"].validate({
				connectionId,
				runtimeGeneration: "3",
			}),
		).toEqual({ value: { connectionId, runtimeGeneration: 3, limit: 20 } });

		for (const input of [
			{
				target: {
					kind: "connection",
					connectionId,
					expectedRevision: 2,
					runtimeGeneration: 3,
				},
				planId: "untrusted-plan",
			},
			{ connectionId, runtimeGeneration: ["3"] },
			{ connectionId, runtimeGeneration: "3", unexpected: true },
		]) {
			const schema =
				"target" in input ? CreateConformanceRunDto.schema : ListConformanceRunsQueryDto.schema;
			const result = await schema["~standard"].validate(input);
			expect(result).toHaveProperty("issues");
		}
	});

	it("trims hub namespaces before validating the namespace contract", async () => {
		expect(
			await AttachHubMemberDto.schema["~standard"].validate({
				namespace: "  fixture  ",
				expectedHubRevision: 1,
				expectedConnectionRevision: 2,
				runtimeGeneration: 3,
			}),
		).toEqual({
			value: {
				namespace: "fixture",
				expectedHubRevision: 1,
				expectedConnectionRevision: 2,
				runtimeGeneration: 3,
			},
		});
	});

	it("bounds prompt argument count, names, values, and total JSON size", async () => {
		const valid = await GetPromptDto.schema["~standard"].validate({
			name: "summarize",
			arguments: { topic: "MCP" },
		});
		expect(valid).toEqual({
			value: { name: "summarize", arguments: { topic: "MCP" } },
		});

		const invalidArguments = [
			Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`arg-${String(index)}`, "x"])),
			{ ["x".repeat(201)]: "value" },
			{ topic: "x".repeat(16 * 1_024 + 1) },
			Object.fromEntries(
				Array.from({ length: 5 }, (_, index) => [`arg-${String(index)}`, "x".repeat(14_000)]),
			),
		];

		for (const promptArguments of invalidArguments) {
			const result = await GetPromptDto.schema["~standard"].validate({
				name: "summarize",
				arguments: promptArguments,
			});
			expect(result).toHaveProperty("issues");
		}
	});
});
