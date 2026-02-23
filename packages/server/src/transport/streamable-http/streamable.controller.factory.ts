import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  type Type,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { StreamableHttpService } from './streamable.service';

export function createStreamableHttpController(endpoint: string): Type<any> {
  @Controller({ path: endpoint, version: VERSION_NEUTRAL })
  class StreamableHttpController {
    constructor(private readonly streamableService: StreamableHttpService) {}

    @Post()
    async handlePost(@Req() req: any, @Res() res: any): Promise<void> {
      await this.streamableService.handlePostRequest(req, res);
    }

    @Get()
    async handleGet(@Req() req: any, @Res() res: any): Promise<void> {
      await this.streamableService.handleGetRequest(req, res);
    }

    @Delete()
    async handleDelete(@Req() req: any, @Res() res: any): Promise<void> {
      await this.streamableService.handleDeleteRequest(req, res);
    }
  }

  return StreamableHttpController;
}
