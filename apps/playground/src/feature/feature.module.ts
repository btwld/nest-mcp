import { McpModule } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { AnalyticsTools } from './analytics.tools';

@Module({
  imports: [McpModule.forFeature([AnalyticsTools])],
})
export class FeatureModule {}
