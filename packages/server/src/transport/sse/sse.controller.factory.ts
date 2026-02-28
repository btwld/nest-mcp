import { Controller, Get, Post, Req, Res, type Type, VERSION_NEUTRAL } from '@nestjs/common';
import { SseService } from './sse.service';

export function createSseController(
  sseEndpoint: string,
  messagesEndpoint: string,
): Type<unknown>[] {
  @Controller({ path: sseEndpoint, version: VERSION_NEUTRAL })
  class SseController {
    constructor(private readonly sseService: SseService) {}

    @Get()
    async handleSse(@Req() req: unknown, @Res() res: unknown): Promise<void> {
      await this.sseService.createConnection(req, res);
    }
  }

  @Controller({ path: messagesEndpoint, version: VERSION_NEUTRAL })
  class SseMessagesController {
    constructor(private readonly sseService: SseService) {}

    @Post()
    async handleMessage(@Req() req: unknown, @Res() res: unknown): Promise<void> {
      await this.sseService.handleMessage(req, res);
    }
  }

  return [SseController, SseMessagesController];
}
