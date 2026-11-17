import {
	Body,
	Controller,
	Get,
	Header,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
} from "@nestjs/common";
import {
	ApiAcceptedResponse,
	ApiOkResponse,
	ApiOperation,
	ApiParam,
	ApiQuery,
	ApiTags,
} from "@nestjs/swagger";

import { CreateConformanceRunDto, ListConformanceRunsQueryDto } from "./conformance.dto.ts";
import {
	ConformanceRunListResponseDto,
	ConformanceRunResponseDto,
} from "./conformance.response.ts";
import { ConformanceService } from "./conformance.service.ts";

@ApiTags("MCP conformance")
@Controller("v1/mcp/conformance/runs")
export class ConformanceController {
	constructor(@Inject(ConformanceService) private readonly conformance: ConformanceService) {}

	@Post()
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: "Queue the server-owned passive safe-discovery-v1 plan" })
	@ApiAcceptedResponse({ type: ConformanceRunResponseDto })
	start(@Body({ schema: CreateConformanceRunDto.schema }) body: CreateConformanceRunDto) {
		return this.conformance.start(body);
	}

	@Get()
	@Header("Cache-Control", "no-store")
	@ApiOkResponse({ type: ConformanceRunListResponseDto })
	@ApiQuery({ name: "connectionId", required: true, type: "string", format: "uuid" })
	@ApiQuery({
		name: "runtimeGeneration",
		required: true,
		type: "integer",
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
	})
	@ApiQuery({
		name: "limit",
		required: false,
		type: "integer",
		minimum: 1,
		maximum: 100,
		default: 20,
	})
	list(@Query() query: ListConformanceRunsQueryDto) {
		return this.conformance.list(query.connectionId, query.runtimeGeneration, query.limit);
	}

	@Get(":runId")
	@Header("Cache-Control", "no-store")
	@ApiOkResponse({ type: ConformanceRunResponseDto })
	@ApiParam({ name: "runId", type: "string", format: "uuid" })
	get(@Param("runId", ParseUUIDPipe) runId: string) {
		return this.conformance.get(runId);
	}

	@Post(":runId/cancel")
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiAcceptedResponse({ type: ConformanceRunResponseDto })
	@ApiParam({ name: "runId", type: "string", format: "uuid" })
	cancel(@Param("runId", ParseUUIDPipe) runId: string) {
		return this.conformance.cancel(runId);
	}
}
