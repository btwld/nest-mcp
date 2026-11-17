import {
	ArgumentsHost,
	Catch,
	HttpException,
	HttpStatus,
	Inject,
	Logger,
	type ExceptionFilter,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { McpRuntimeManagerError } from "@nest-mcp/manager";

import { ControlPlaneError } from "./control-plane.error.ts";

interface ProblemDetails {
	readonly statusCode: number;
	readonly code: string;
	readonly message: string;
	readonly details?: readonly string[];
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
	readonly #logger = new Logger(ApiExceptionFilter.name);

	constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

	catch(error: unknown, host: ArgumentsHost): void {
		const response = host.switchToHttp().getResponse<unknown>();
		const problem = this.#toProblem(error);
		if (problem.statusCode >= 500) {
			this.#logger.error(
				`Request failed with ${problem.code}.`,
				problem.code === "INTERNAL_ERROR" && error instanceof Error ? error.stack : undefined,
			);
		}
		this.adapterHost.httpAdapter.reply(response, problem, problem.statusCode);
	}

	#toProblem(error: unknown): ProblemDetails {
		if (error instanceof ControlPlaneError) {
			return Object.freeze({
				statusCode: error.status,
				code: error.code,
				message: error.message,
			});
		}
		if (error instanceof McpRuntimeManagerError) {
			return Object.freeze({
				statusCode: runtimeErrorStatus(error.code),
				code: error.code,
				message: error.message,
			});
		}
		if (error instanceof HttpException) {
			const statusCode = error.getStatus();
			const payload = error.getResponse();
			const details = validationMessages(payload);
			const isBadRequest = statusCode === 400;
			return Object.freeze({
				statusCode,
				code: isBadRequest ? "REQUEST_INVALID" : "HTTP_ERROR",
				message: isBadRequest ? "The request is invalid." : error.message,
				...(details.length === 0 ? {} : { details }),
			});
		}
		return Object.freeze({
			statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
			code: "INTERNAL_ERROR",
			message: "The request could not be completed.",
		});
	}
}

function runtimeErrorStatus(code: McpRuntimeManagerError["code"]): number {
	switch (code) {
		case "MCP_DISCOVERY_LIMIT_EXCEEDED":
			return 422;
		case "MCP_GENERATION_RETIRED":
		case "MCP_LEASE_MODE_CONFLICT":
		case "MCP_NOT_READY":
			return 409;
		case "MCP_ADMISSION_TIMEOUT":
			return 504;
		case "MCP_QUEUE_FULL":
		case "MCP_CAPACITY_EXCEEDED":
		case "MCP_QUARANTINED":
		case "MCP_RUNTIME_CLOSED":
			return 503;
		case "MCP_UPSTREAM_FAILED":
			return 502;
	}
	return unreachableRuntimeErrorStatus(code);
}

function unreachableRuntimeErrorStatus(code: never): never {
	throw new TypeError(`Unsupported MCP runtime manager error code: ${String(code)}`);
}

function validationMessages(payload: string | object): readonly string[] {
	if (typeof payload !== "object" || payload === null || !("message" in payload)) return [];
	const message = payload.message;
	if (typeof message === "string") return Object.freeze([message]);
	if (!Array.isArray(message)) return [];
	return Object.freeze(message.filter((entry): entry is string => typeof entry === "string"));
}
