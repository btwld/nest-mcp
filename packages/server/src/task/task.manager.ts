import type { TaskStore, TaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/**
 * Manages task lifecycle and session-scoped task tracking.
 *
 * Wraps the SDK's in-memory task store and message queue, adding
 * session-to-task tracking so tasks can be cleaned up when a session closes.
 *
 * The underlying `TaskStore` and `TaskMessageQueue` are passed to the
 * SDK's `McpServer` constructor, which automatically registers handlers
 * for `tasks/get`, `tasks/list`, `tasks/cancel`, and `tasks/result`.
 */
@Injectable()
export class TaskManager implements OnModuleDestroy {
  private readonly logger = new Logger(TaskManager.name);
  private readonly taskStore = new InMemoryTaskStore();
  private readonly messageQueue = new InMemoryTaskMessageQueue();

  /** sessionId -> Set of taskIds created in that session */
  private readonly sessionTasks = new Map<string, Set<string>>();

  get store(): TaskStore {
    return this.taskStore;
  }

  get queue(): TaskMessageQueue {
    return this.messageQueue;
  }

  /** Associate a task with a session for cleanup tracking. */
  trackTask(taskId: string, sessionId: string): void {
    let tasks = this.sessionTasks.get(sessionId);
    if (!tasks) {
      tasks = new Set();
      this.sessionTasks.set(sessionId, tasks);
    }
    tasks.add(taskId);
  }

  /**
   * Remove all tasks for a session. Non-terminal tasks are cancelled.
   * Called when a transport session closes.
   */
  async removeSession(sessionId: string): Promise<void> {
    const taskIds = this.sessionTasks.get(sessionId);
    if (!taskIds || taskIds.size === 0) {
      this.sessionTasks.delete(sessionId);
      return;
    }

    for (const taskId of taskIds) {
      try {
        const task = await this.taskStore.getTask(taskId);
        if (task && !isTerminalStatus(task.status)) {
          await this.taskStore.updateTaskStatus(
            taskId,
            'cancelled',
            'Session closed',
          );
        }
      } catch {
        // Task may already be cleaned up by TTL
        this.logger.debug(`Could not cancel task ${taskId} during session cleanup`);
      }
    }

    this.sessionTasks.delete(sessionId);
    this.logger.debug(`Cleaned up tasks for session ${sessionId}`);
  }

  onModuleDestroy(): void {
    this.taskStore.cleanup();
    this.sessionTasks.clear();
  }
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
