import type { ArgumentsHost } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import {
	MCP_RUNTIME_CAPACITY_EXCEEDED,
	MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED,
	MCP_RUNTIME_GENERATION_RETIRED,
	MCP_RUNTIME_LEASE_MODE_CONFLICT,
	MCP_RUNTIME_MANAGER_CLOSED,
	MCP_RUNTIME_NOT_READY,
	MCP_RUNTIME_QUARANTINED,
	MCP_RUNTIME_UPSTREAM_FAILED,
	McpRuntimeManagerError,
} from "@nest-mcp/manager";
import { describe, expect, it, vi } from "vitest";

import { ApiExceptionFilter } from "../src/common/api-exception.filter.ts";

describe("ApiExceptionFilter MCP manager mapping", () => {
	it.each([
		[MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED, 422],
		[MCP_RUNTIME_GENERATION_RETIRED, 409],
		[MCP_RUNTIME_LEASE_MODE_CONFLICT, 409],
		[MCP_RUNTIME_NOT_READY, 409],
		[MCP_RUNTIME_CAPACITY_EXCEEDED, 503],
		[MCP_RUNTIME_QUARANTINED, 503],
		[MCP_RUNTIME_MANAGER_CLOSED, 503],
		[MCP_RUNTIME_UPSTREAM_FAILED, 502],
	] as const)("maps %s to the established HTTP status", (code, statusCode) => {
		const reply = vi.fn();
		const response = {};
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const filter = new ApiExceptionFilter({
			httpAdapter: { reply },
		} as unknown as HttpAdapterHost);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const host = {
			switchToHttp: () => ({ getResponse: () => response }),
		} as unknown as ArgumentsHost;

		filter.catch(new McpRuntimeManagerError(code, "Safe manager error."), host);

		expect(reply).toHaveBeenCalledWith(
			response,
			{
				statusCode,
				code,
				message: "Safe manager error.",
			},
			statusCode,
		);
	});
});
