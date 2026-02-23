import { RequestTransformService, type ToolCallRequest } from './request-transform.service';

describe('RequestTransformService', () => {
  let service: RequestTransformService;

  beforeEach(() => {
    service = new RequestTransformService();
  });

  const baseRequest: ToolCallRequest = {
    toolName: 'listRepos',
    arguments: { org: 'acme' },
    upstreamName: 'github',
  };

  describe('apply', () => {
    it('should pass through request unchanged when no transforms are registered', async () => {
      const result = await service.apply(baseRequest);
      expect(result).toEqual(baseRequest);
    });

    it('should apply a single transform', async () => {
      service.register((req) => ({
        ...req,
        arguments: { ...req.arguments, extra: true },
      }));

      const result = await service.apply(baseRequest);

      expect(result.arguments).toEqual({ org: 'acme', extra: true });
    });

    it('should chain multiple transforms in order', async () => {
      service.register((req) => ({ ...req, toolName: req.toolName + '_1' }));
      service.register((req) => ({ ...req, toolName: req.toolName + '_2' }));

      const result = await service.apply(baseRequest);

      expect(result.toolName).toBe('listRepos_1_2');
    });

    it('should support async transforms', async () => {
      service.register(async (req) => {
        return { ...req, toolName: 'async_' + req.toolName };
      });

      const result = await service.apply(baseRequest);

      expect(result.toolName).toBe('async_listRepos');
    });

    it('should propagate errors from transforms', async () => {
      service.register(() => {
        throw new Error('transform failed');
      });

      await expect(service.apply(baseRequest)).rejects.toThrow('transform failed');
    });
  });
});
