import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { TaskAggregatorService } from './task-aggregator.service';

const makeTask = (taskId: string, status: 'working' | 'completed' = 'working') => ({
  taskId,
  status,
  ttl: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastUpdatedAt: '2024-01-01T00:00:00Z',
});

describe('TaskAggregatorService', () => {
  let service: TaskAggregatorService;
  let upstreamManager: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    upstreamManager = {
      getAllNames: vi.fn().mockReturnValue([]),
      getClient: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
    };
    service = new TaskAggregatorService(upstreamManager as unknown as UpstreamManagerService);
  });

  // --- ID helpers ---

  describe('buildTaskId / parseTaskId', () => {
    it('builds a prefixed task ID', () => {
      expect(service.buildTaskId('upstream1', 'task-abc')).toBe('upstream1::task-abc');
    });

    it('parses a prefixed task ID', () => {
      expect(service.parseTaskId('upstream1::task-abc')).toEqual({
        upstreamName: 'upstream1',
        originalId: 'task-abc',
      });
    });

    it('handles task IDs that contain :: in the task part', () => {
      // Only the first :: is the separator
      expect(service.parseTaskId('upstream1::part1::part2')).toEqual({
        upstreamName: 'upstream1',
        originalId: 'part1::part2',
      });
    });

    it('returns undefined for an unprefixed ID', () => {
      expect(service.parseTaskId('task-abc')).toBeUndefined();
    });
  });

  // --- listTasks ---

  describe('listTasks', () => {
    it('fans out to all healthy upstreams and merges results', async () => {
      upstreamManager.getAllNames.mockReturnValue(['a', 'b']);
      const clientA = {
        experimental: { tasks: { listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('t1')] }) } },
      };
      const clientB = {
        experimental: { tasks: { listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('t2')] }) } },
      };
      upstreamManager.getClient.mockImplementation((name: string) =>
        name === 'a' ? clientA : clientB,
      );

      const result = await service.listTasks();

      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].taskId).toBe('a::t1');
      expect(result.tasks[1].taskId).toBe('b::t2');
    });

    it('skips unhealthy upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['a', 'b']);
      upstreamManager.isHealthy.mockImplementation((name: string) => name === 'a');
      const clientA = {
        experimental: { tasks: { listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('t1')] }) } },
      };
      upstreamManager.getClient.mockReturnValue(clientA);

      const result = await service.listTasks();

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].taskId).toBe('a::t1');
    });

    it('skips upstreams with no client', async () => {
      upstreamManager.getAllNames.mockReturnValue(['a']);
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.listTasks();

      expect(result.tasks).toHaveLength(0);
    });

    it('gracefully ignores failed upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['a', 'b']);
      const clientA = {
        experimental: { tasks: { listTasks: vi.fn().mockRejectedValue(new Error('network error')) } },
      };
      const clientB = {
        experimental: { tasks: { listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('t2')] }) } },
      };
      upstreamManager.getClient.mockImplementation((name: string) =>
        name === 'a' ? clientA : clientB,
      );

      const result = await service.listTasks();

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].taskId).toBe('b::t2');
    });

    it('forwards cursor to each upstream', async () => {
      upstreamManager.getAllNames.mockReturnValue(['a']);
      const client = {
        experimental: { tasks: { listTasks: vi.fn().mockResolvedValue({ tasks: [] }) } },
      };
      upstreamManager.getClient.mockReturnValue(client);

      await service.listTasks('cursor-123');

      expect(client.experimental.tasks.listTasks).toHaveBeenCalledWith('cursor-123');
    });

    it('returns empty list when no upstreams', async () => {
      const result = await service.listTasks();
      expect(result.tasks).toHaveLength(0);
    });
  });

  // --- getTask ---

  describe('getTask', () => {
    it('returns prefixed task from upstream', async () => {
      const client = {
        experimental: {
          tasks: { getTask: vi.fn().mockResolvedValue(makeTask('task-abc', 'completed')) },
        },
      };
      upstreamManager.getClient.mockReturnValue(client);

      const result = await service.getTask('upstream1::task-abc');

      expect(client.experimental.tasks.getTask).toHaveBeenCalledWith('task-abc');
      expect(result?.taskId).toBe('upstream1::task-abc');
      expect(result?.status).toBe('completed');
    });

    it('returns undefined for unprefixed task ID', async () => {
      expect(await service.getTask('task-abc')).toBeUndefined();
    });

    it('returns undefined when upstream is unhealthy', async () => {
      upstreamManager.isHealthy.mockReturnValue(false);
      expect(await service.getTask('upstream1::task-abc')).toBeUndefined();
    });

    it('returns undefined when client is not connected', async () => {
      upstreamManager.getClient.mockReturnValue(undefined);
      expect(await service.getTask('upstream1::task-abc')).toBeUndefined();
    });

    it('returns undefined when upstream call throws', async () => {
      upstreamManager.getClient.mockReturnValue({
        experimental: { tasks: { getTask: vi.fn().mockRejectedValue(new Error('not found')) } },
      });

      expect(await service.getTask('upstream1::task-abc')).toBeUndefined();
    });
  });

  // --- cancelTask ---

  describe('cancelTask', () => {
    it('cancels task on upstream and returns prefixed result', async () => {
      const client = {
        experimental: {
          tasks: { cancelTask: vi.fn().mockResolvedValue(makeTask('task-abc', 'completed')) },
        },
      };
      upstreamManager.getClient.mockReturnValue(client);

      const result = await service.cancelTask('upstream1::task-abc');

      expect(client.experimental.tasks.cancelTask).toHaveBeenCalledWith('task-abc');
      expect(result?.taskId).toBe('upstream1::task-abc');
    });

    it('returns undefined for unprefixed task ID', async () => {
      expect(await service.cancelTask('task-abc')).toBeUndefined();
    });

    it('returns undefined when upstream is unhealthy', async () => {
      upstreamManager.isHealthy.mockReturnValue(false);
      expect(await service.cancelTask('upstream1::task-abc')).toBeUndefined();
    });

    it('returns undefined when upstream call throws', async () => {
      upstreamManager.getClient.mockReturnValue({
        experimental: { tasks: { cancelTask: vi.fn().mockRejectedValue(new Error('error')) } },
      });

      expect(await service.cancelTask('upstream1::task-abc')).toBeUndefined();
    });
  });

  // --- getTaskPayload ---

  describe('getTaskPayload', () => {
    it('forwards to upstream and returns payload', async () => {
      const payload = { content: [{ type: 'text', text: 'result' }] };
      const client = {
        experimental: { tasks: { getTaskResult: vi.fn().mockResolvedValue(payload) } },
      };
      upstreamManager.getClient.mockReturnValue(client);

      const result = await service.getTaskPayload('upstream1::task-abc');

      expect(client.experimental.tasks.getTaskResult).toHaveBeenCalledWith('task-abc');
      expect(result).toEqual(payload);
    });

    it('throws for an unprefixed task ID', async () => {
      await expect(service.getTaskPayload('task-abc')).rejects.toThrow('Invalid task ID');
    });

    it('throws when upstream is unhealthy', async () => {
      upstreamManager.isHealthy.mockReturnValue(false);
      await expect(service.getTaskPayload('upstream1::task-abc')).rejects.toThrow('not healthy');
    });

    it('throws when client is not connected', async () => {
      upstreamManager.getClient.mockReturnValue(undefined);
      await expect(service.getTaskPayload('upstream1::task-abc')).rejects.toThrow('not connected');
    });
  });
});
