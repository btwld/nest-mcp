import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('tools')
  async listTools() {
    return this.appService.listTools();
  }

  @Post('tools/:name')
  async callTool(@Param('name') name: string, @Body() args: Record<string, unknown> = {}) {
    return this.appService.callTool(name, args);
  }

  @Get('resources')
  async listResources() {
    return this.appService.listResources();
  }

  @Get('resources/read')
  async readResource(@Query('uri') uri: string) {
    return this.appService.readResource(uri);
  }

  @Get('prompts')
  async listPrompts() {
    return this.appService.listPrompts();
  }

  @Get('prompts/:name')
  async getPrompt(@Param('name') name: string, @Query() args: Record<string, string> = {}) {
    return this.appService.getPrompt(name, args);
  }

  @Get('ping')
  async ping() {
    return this.appService.ping();
  }

  @Get('status')
  getStatus() {
    return this.appService.getStatus();
  }
}
