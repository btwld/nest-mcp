import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // --- Playground endpoints ---

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

  // --- SSE Server endpoints ---

  @Get('sse-server/tools')
  async listSseTools() {
    return this.appService.listSseTools();
  }

  @Post('sse-server/tools/:name')
  async callSseTool(@Param('name') name: string, @Body() args: Record<string, unknown> = {}) {
    return this.appService.callSseTool(name, args);
  }

  @Get('sse-server/resources')
  async listSseResources() {
    return this.appService.listSseResources();
  }

  // --- Stdio Server endpoints ---

  @Get('stdio-server/tools')
  async listStdioTools() {
    return this.appService.listStdioTools();
  }

  @Post('stdio-server/tools/:name')
  async callStdioTool(@Param('name') name: string, @Body() args: Record<string, unknown> = {}) {
    return this.appService.callStdioTool(name, args);
  }

  @Get('stdio-server/resources')
  async listStdioResources() {
    return this.appService.listStdioResources();
  }

  @Get('stdio-server/prompts')
  async listStdioPrompts() {
    return this.appService.listStdioPrompts();
  }

  // --- Multi-client endpoints ---

  @Get('connections')
  getConnections() {
    return this.appService.getConnectionStatus();
  }

  @Get('all-tools')
  async listAllTools() {
    return this.appService.listAllTools();
  }
}
