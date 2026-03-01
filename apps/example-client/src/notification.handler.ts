import { OnMcpNotification } from '@nest-mcp/client';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationHandler {
  private readonly logger = new Logger(NotificationHandler.name);

  // Playground notifications
  @OnMcpNotification('playground', 'notifications/tools/list_changed')
  async onPlaygroundToolsChanged() {
    this.logger.log('Playground tools list has changed');
  }

  @OnMcpNotification('playground', 'notifications/resources/list_changed')
  async onPlaygroundResourcesChanged() {
    this.logger.log('Playground resources list has changed');
  }

  @OnMcpNotification('playground', 'notifications/prompts/list_changed')
  async onPlaygroundPromptsChanged() {
    this.logger.log('Playground prompts list has changed');
  }

  // SSE Server notifications
  @OnMcpNotification('sse-server', 'notifications/tools/list_changed')
  async onSseToolsChanged() {
    this.logger.log('SSE Server tools list has changed');
  }

  @OnMcpNotification('sse-server', 'notifications/resources/list_changed')
  async onSseResourcesChanged() {
    this.logger.log('SSE Server resources list has changed');
  }
}
