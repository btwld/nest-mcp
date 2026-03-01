import { McpModule, McpTransportType } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { BrowserService } from './browser/browser.service';
import { WebContentService } from './browser/web-content.service';
import { FetchTools } from './tools/fetch.tools';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'browser-mcp',
      version: '0.1.0',
      description: 'MCP server for fetching web content using a headless Playwright browser',
      transport: McpTransportType.STREAMABLE_HTTP,
      capabilities: {
        tools: { listChanged: false },
      },
    }),
  ],
  providers: [BrowserService, WebContentService, FetchTools],
})
export class AppModule {}
