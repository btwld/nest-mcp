import {
	Controller,
	Get,
	Header,
	Param,
	ParseIntPipe,
	ParseUUIDPipe,
	Post,
	Query,
	Redirect,
	Req,
} from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { OAuthControlService } from "./oauth-control.service.ts";

@ApiTags("MCP OAuth")
@Controller()
export class OAuthController {
	constructor(private readonly oauth: OAuthControlService) {}

	@Post("v1/mcp/connections/:connectionId/oauth/authorize")
	@Redirect(undefined, 303)
	@Header("Cache-Control", "no-store")
	@Header("Referrer-Policy", "no-referrer")
	@ApiOperation({ summary: "Begin interactive OAuth authorization in the current browser" })
	@ApiResponse({ status: 303, description: "Redirect to the admitted authorization endpoint." })
	async authorize(
		@Param("connectionId", ParseUUIDPipe) connectionId: string,
		@Query("expectedRevision", ParseIntPipe) expectedRevision: number,
	): Promise<{ readonly url: string; readonly statusCode: 303 }> {
		try {
			return { url: await this.oauth.authorize(connectionId, expectedRevision), statusCode: 303 };
		} catch (error) {
			return {
				url: this.oauth.uiRedirect({
					oauth: "failed",
					connectionId,
					code: safeOAuthErrorCode(error),
				}),
				statusCode: 303,
			};
		}
	}

	@Get("v1/mcp/oauth/callback")
	@Redirect(undefined, 303)
	@Header("Cache-Control", "no-store")
	@Header("Referrer-Policy", "no-referrer")
	@ApiExcludeEndpoint()
	async callback(
		@Req() request: FastifyRequest,
	): Promise<{ readonly url: string; readonly statusCode: 303 }> {
		const callback = new URL(request.url, "http://127.0.0.1");
		const outcome = await this.oauth.completeCallback(callback.searchParams);
		return { url: this.oauth.uiRedirect(outcome), statusCode: 303 };
	}
}

function safeOAuthErrorCode(error: unknown): string {
	if (error instanceof ControlPlaneError) return error.code;
	return "MCP_OAUTH_UPSTREAM_FAILED";
}
