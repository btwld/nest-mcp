import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  type Type,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { StreamableHttpService } from './streamable.service';

export function createStreamableHttpController(endpoint: string): Type<unknown> {
  @Controller({ path: endpoint, version: VERSION_NEUTRAL })
  class StreamableHttpController {
    constructor(private readonly streamableService: StreamableHttpService) {}

    @Post()
    async handlePost(@Req() req: unknown, @Res() res: unknown): Promise<void> {
      await this.streamableService.handlePostRequest(req, res);
    }

    @Get()
    async handleGet(@Req() req: unknown, @Res() res: unknown): Promise<void> {
      await this.streamableService.handleGetRequest(req, res);
    }

    @Delete()
    async handleDelete(@Req() req: unknown, @Res() res: unknown): Promise<void> {
      await this.streamableService.handleDeleteRequest(req, res);
    }
  }

  return StreamableHttpController;
}
