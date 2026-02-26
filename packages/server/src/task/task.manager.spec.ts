import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskManager } from './task.manager';

describe('TaskManager', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  afterEach(() => {
    manager.onModuleDestroy();
  });

  it('exposes a task store and message queue', () => {
    expect(manager.store).toBeDefined();
    expect(manager.queue).toBeDefined();
    expect(typeof manager.store.createTask).toBe('function');
    expect(typeof manager.queue.enqueue).toBe('function');
  });

  it('tracks tasks to sessions', () => {
    manager.trackTask('task-1', 'session-a');
    manager.trackTask('task-2', 'session-a');
    manager.trackTask('task-3', 'session-b');

    // No public getter for sessionTasks, but we can verify through removeSession
    // by creating real tasks first
  });

  it('removeSession cancels working tasks', async () => {
    // Create a real task via the store
    const task = await manager.store.createTask(
      { ttl: null },
      'req-1',
      { method: 'tools/call', params: { name: 'test' } },
    );
    expect(task.status).toBe('working');

    // Track it to a session
    manager.trackTask(task.taskId, 'session-1');

    // Remove the session — should cancel the task
    await manager.removeSession('session-1');

    const updated = await manager.store.getTask(task.taskId);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('cancelled');
    expect(updated!.statusMessage).toBe('Session closed');
  });

  it('removeSession does not affect tasks in other sessions', async () => {
    const task1 = await manager.store.createTask(
      { ttl: null },
      'req-1',
      { method: 'tools/call', params: { name: 'a' } },
    );
    const task2 = await manager.store.createTask(
      { ttl: null },
      'req-2',
      { method: 'tools/call', params: { name: 'b' } },
    );

    manager.trackTask(task1.taskId, 'session-1');
    manager.trackTask(task2.taskId, 'session-2');

    await manager.removeSession('session-1');

    const updated1 = await manager.store.getTask(task1.taskId);
    const updated2 = await manager.store.getTask(task2.taskId);

    expect(updated1!.status).toBe('cancelled');
    expect(updated2!.status).toBe('working');
  });

  it('removeSession skips tasks already in terminal state', async () => {
    const task = await manager.store.createTask(
      { ttl: null },
      'req-1',
      { method: 'tools/call', params: { name: 'test' } },
    );

    // Complete the task before session cleanup
    await manager.store.storeTaskResult(task.taskId, 'completed', { content: [] });

    manager.trackTask(task.taskId, 'session-1');
    await manager.removeSession('session-1');

    const updated = await manager.store.getTask(task.taskId);
    expect(updated!.status).toBe('completed');
  });

  it('removeSession is safe for unknown sessions', async () => {
    await expect(manager.removeSession('non-existent')).resolves.not.toThrow();
  });

  it('removeSession is safe for sessions with no tracked tasks', async () => {
    // Track then remove a task manually (simulating TTL cleanup)
    manager.trackTask('ghost-task', 'session-1');

    // The task doesn't actually exist in the store, removeSession should handle gracefully
    await expect(manager.removeSession('session-1')).resolves.not.toThrow();
  });

  it('onModuleDestroy cleans up internal state', async () => {
    const task = await manager.store.createTask(
      { ttl: null },
      'req-1',
      { method: 'tools/call', params: { name: 'test' } },
    );
    manager.trackTask(task.taskId, 'session-1');

    manager.onModuleDestroy();

    // After cleanup, store should be empty
    const result = await manager.store.listTasks();
    expect(result.tasks).toHaveLength(0);
  });

  it('handles multiple tasks per session', async () => {
    const task1 = await manager.store.createTask(
      { ttl: null },
      'req-1',
      { method: 'tools/call', params: { name: 'a' } },
    );
    const task2 = await manager.store.createTask(
      { ttl: null },
      'req-2',
      { method: 'tools/call', params: { name: 'b' } },
    );

    manager.trackTask(task1.taskId, 'session-1');
    manager.trackTask(task2.taskId, 'session-1');

    await manager.removeSession('session-1');

    const updated1 = await manager.store.getTask(task1.taskId);
    const updated2 = await manager.store.getTask(task2.taskId);

    expect(updated1!.status).toBe('cancelled');
    expect(updated2!.status).toBe('cancelled');
  });
});
