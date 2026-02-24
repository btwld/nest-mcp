import { OnMcpNotification } from '@btwld/mcp-client';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationHandler {
  private readonly logger = new Logger(NotificationHandler.name);

  @OnMcpNotification('playground', 'notifications/tools/list_changed')
  async onToolsChanged() {
    this.logger.log('Playground tools list has changed');
  }

  @OnMcpNotification('playground', 'notifications/resources/list_changed')
  async onResourcesChanged() {
    this.logger.log('Playground resources list has changed');
  }

  @OnMcpNotification('playground', 'notifications/prompts/list_changed')
  async onPromptsChanged() {
    this.logger.log('Playground prompts list has changed');
  }
}
