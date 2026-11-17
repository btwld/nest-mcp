import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	ParseIntPipe,
	ParseUUIDPipe,
	Post,
	Put,
	Query,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";

import {
	CallToolDto,
	CreateConnectionDto,
	GetPromptDto,
	ReadResourceDto,
	ReplaceConnectionDto,
	SetDesiredStateDto,
} from "./connection.dto.ts";
import { ConnectionControlService, type ConnectionView } from "./connection-control.service.ts";
import {
	CatalogResponseDto,
	ConnectionResponseDto,
	ProbeResponseDto,
} from "./connection.response.ts";

@ApiTags("MCP connections")
@Controller("v1/mcp/connections")
export class ConnectionController {
	constructor(
		@Inject(ConnectionControlService) private readonly control: ConnectionControlService,
	) {}

	@Post()
	@ApiCreatedResponse({ type: ConnectionResponseDto })
	create(
		@Body({ schema: CreateConnectionDto.schema }) body: CreateConnectionDto,
	): Promise<ConnectionView> {
		return this.control.create({
			displayName: body.displayName,
			endpoint: body.endpoint,
			desiredState: body.desiredState ?? "offline",
			authenticationKind: body.authentication?.kind ?? "none",
		});
	}

	@Get()
	@ApiOkResponse({ type: [ConnectionResponseDto] })
	list(): readonly ConnectionView[] {
		return this.control.list();
	}

	@Get(":connectionId")
	@ApiOkResponse({ type: ConnectionResponseDto })
	get(@Param("connectionId", ParseUUIDPipe) connectionId: string): ConnectionView {
		return this.control.get(connectionId);
	}

	@Put(":connectionId")
	@ApiOkResponse({ type: ConnectionResponseDto })
	replace(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Body({ schema: ReplaceConnectionDto.schema }) body: ReplaceConnectionDto,
	): Promise<ConnectionView> {
		return this.control.replace(connectionId, body.expectedRevision, {
			displayName: body.displayName,
			...(body.endpoint === undefined ? {} : { endpoint: body.endpoint }),
		});
	}

	@Delete(":connectionId")
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiNoContentResponse()
	remove(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Query("expectedRevision", ParseIntPipe) expectedRevision: number,
	): Promise<void> {
		return this.control.remove(connectionId, expectedRevision);
	}

	@Put(":connectionId/desired-state")
	@ApiOkResponse({ type: ConnectionResponseDto })
	setDesiredState(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Body({ schema: SetDesiredStateDto.schema }) body: SetDesiredStateDto,
	): Promise<ConnectionView> {
		return this.control.setDesiredState(connectionId, body.expectedRevision, body.state);
	}

	@Post(":connectionId/probe")
	@HttpCode(HttpStatus.OK)
	@ApiOkResponse({ type: ProbeResponseDto })
	probe(@Param("connectionId", ParseUUIDPipe) connectionId: string) {
		return this.control.probe(connectionId);
	}

	@Get(":connectionId/catalog")
	@ApiOkResponse({ type: CatalogResponseDto })
	getCatalog(@Param("connectionId", ParseUUIDPipe) connectionId: string) {
		return this.control.getCatalog(connectionId);
	}

	@Post(":connectionId/catalog/refresh")
	@HttpCode(HttpStatus.OK)
	@ApiOkResponse({ type: CatalogResponseDto })
	refreshCatalog(@Param("connectionId", ParseUUIDPipe) connectionId: string) {
		return this.control.refreshCatalog(connectionId);
	}

	@Post(":connectionId/tools/call")
	@HttpCode(HttpStatus.OK)
	@ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
	callTool(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Body({ schema: CallToolDto.schema }) body: CallToolDto,
	) {
		return this.control.callTool(connectionId, body.name, body.arguments ?? {});
	}

	@Post(":connectionId/resources/read")
	@HttpCode(HttpStatus.OK)
	@ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
	readResource(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Body({ schema: ReadResourceDto.schema }) body: ReadResourceDto,
	) {
		return this.control.readResource(connectionId, body.uri);
	}

	@Post(":connectionId/prompts/get")
	@HttpCode(HttpStatus.OK)
	@ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
	getPrompt(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Body({ schema: GetPromptDto.schema }) body: GetPromptDto,
	) {
		return this.control.getPrompt(connectionId, body.name, body.arguments);
	}
}
