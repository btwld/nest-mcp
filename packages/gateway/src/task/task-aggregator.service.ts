import type { GetTaskPayloadResult, Task } from '@modelcontextprotocol/sdk/types.js';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';

@Injectable()
export class TaskAggregatorService {
  private readonly logger = new Logger(TaskAggregatorService.name);

  constructor(private readonly upstreamManager: UpstreamManagerService) {}

  /**
   * Build a gateway task ID by prefixing the upstream name.
   * Format: "${upstreamName}::${upstreamTaskId}"
   */
  buildTaskId(upstreamName: string, upstreamTaskId: string): string {
    return `${upstreamName}::${upstreamTaskId}`;
  }

  /**
   * Parse a gateway task ID back into upstream name and original task ID.
   * Returns undefined if the ID is not a valid prefixed gateway task ID.
   */
  parseTaskId(prefixedId: string): { upstreamName: string; originalId: string } | undefined {
    const sep = prefixedId.indexOf('::');
    if (sep === -1) return undefined;
    return { upstreamName: prefixedId.slice(0, sep), originalId: prefixedId.slice(sep + 2) };
  }

  private prefixTask(upstreamName: string, task: Task): Task {
    return { ...task, taskId: this.buildTaskId(upstreamName, task.taskId) };
  }

  /**
   * Fan out tasks/list to all healthy upstreams and merge results.
   * Task IDs are prefixed with the upstream name so they can be routed back.
   */
  async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const names = this.upstreamManager.getAllNames().filter((n) => this.upstreamManager.isHealthy(n));
    const settled = await Promise.allSettled(
      names.map(async (name) => {
        const client = this.upstreamManager.getClient(name);
        if (!client) return [] as Task[];
        const result = await client.experimental.tasks.listTasks(cursor);
        return result.tasks.map((t) => this.prefixTask(name, t));
      }),
    );

    const tasks = settled
      .filter((r): r is PromiseFulfilledResult<Task[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    return { tasks };
  }

  /**
   * Forward tasks/get to the appropriate upstream after unprefixing the task ID.
   */
  async getTask(prefixedId: string): Promise<Task | undefined> {
    const parsed = this.parseTaskId(prefixedId);
    if (!parsed) return undefined;
    if (!this.upstreamManager.isHealthy(parsed.upstreamName)) return undefined;
    const client = this.upstreamManager.getClient(parsed.upstreamName);
    if (!client) return undefined;

    try {
      const result = await client.experimental.tasks.getTask(parsed.originalId);
      return this.prefixTask(parsed.upstreamName, result);
    } catch (error) {
      this.logger.error(`Failed to get task "${prefixedId}": ${error}`);
      return undefined;
    }
  }

  /**
   * Forward tasks/cancel to the appropriate upstream after unprefixing the task ID.
   */
  async cancelTask(prefixedId: string): Promise<Task | undefined> {
    const parsed = this.parseTaskId(prefixedId);
    if (!parsed) return undefined;
    if (!this.upstreamManager.isHealthy(parsed.upstreamName)) return undefined;
    const client = this.upstreamManager.getClient(parsed.upstreamName);
    if (!client) return undefined;

    try {
      const result = await client.experimental.tasks.cancelTask(parsed.originalId);
      return this.prefixTask(parsed.upstreamName, result);
    } catch (error) {
      this.logger.error(`Failed to cancel task "${prefixedId}": ${error}`);
      return undefined;
    }
  }

  /**
   * Forward tasks/result to the appropriate upstream after unprefixing the task ID.
   */
  async getTaskPayload(prefixedId: string): Promise<GetTaskPayloadResult> {
    const parsed = this.parseTaskId(prefixedId);
    if (!parsed) throw new Error(`Invalid task ID: "${prefixedId}"`);
    if (!this.upstreamManager.isHealthy(parsed.upstreamName)) {
      throw new Error(`Upstream "${parsed.upstreamName}" is not healthy`);
    }
    const client = this.upstreamManager.getClient(parsed.upstreamName);
    if (!client) throw new Error(`Upstream "${parsed.upstreamName}" is not connected`);

    // getTaskResult returns the original tool call result; GetTaskPayloadResult is a loose
    // schema that accepts any shape — cast at the SDK proxy boundary
    const result = await client.experimental.tasks.getTaskResult(parsed.originalId);
    return result as GetTaskPayloadResult;
  }
}
