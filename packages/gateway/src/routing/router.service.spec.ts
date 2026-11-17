import type { UpstreamConfig } from '../upstream/upstream.interface';
import type { RoutingConfig } from './route-config.interface';
import { RouterService } from './router.service';

describe('RouterService', () => {
  let service: RouterService;
  const routing: RoutingConfig = { toolRouting: 'prefix' };

  beforeEach(() => {
    service = new RouterService();
  });

  describe('configure', () => {
    it('should populate prefix map from upstreams', () => {
      const upstreams: UpstreamConfig[] = [
        { name: 'github', url: 'http://localhost', transport: 'sse', toolPrefix: 'gh' },
        { name: 'slack', url: 'http://localhost', transport: 'sse', toolPrefix: 'sl' },
      ];

      service.configure(upstreams, routing);

      expect(service.getPrefixForUpstream('github')).toBe('gh');
      expect(service.getPrefixForUpstream('slack')).toBe('sl');
    });

    it('should skip disabled upstreams', () => {
      const upstreams: UpstreamConfig[] = [
        {
          name: 'github',
          url: 'http://localhost',
          transport: 'sse',
          toolPrefix: 'gh',
          enabled: false,
        },
        { name: 'slack', url: 'http://localhost', transport: 'sse', toolPrefix: 'sl' },
      ];

      service.configure(upstreams, routing);

      expect(service.getPrefixForUpstream('github')).toBeUndefined();
      expect(service.getPrefixForUpstream('slack')).toBe('sl');
    });

    it('should use upstream name as fallback when toolPrefix is not set', () => {
      const upstreams: UpstreamConfig[] = [
        { name: 'github', url: 'http://localhost', transport: 'sse' },
      ];

      service.configure(upstreams, routing);

      expect(service.getPrefixForUpstream('github')).toBe('github');
    });

    it('should clear existing prefix map on reconfigure', () => {
      service.configure(
        [{ name: 'old', url: 'http://localhost', transport: 'sse', toolPrefix: 'o' }],
        routing,
      );
      service.configure(
        [{ name: 'new', url: 'http://localhost', transport: 'sse', toolPrefix: 'n' }],
        routing,
      );

      expect(service.getPrefixForUpstream('old')).toBeUndefined();
      expect(service.getPrefixForUpstream('new')).toBe('n');
    });
  });

  describe('resolve', () => {
    beforeEach(() => {
      service.configure(
        [{ name: 'github', url: 'http://localhost', transport: 'sse', toolPrefix: 'gh' }],
        routing,
      );
    });

    it('should resolve a prefixed tool name to upstream and original name', () => {
      const result = service.resolve('gh_listRepos');

      expect(result).toEqual({
        upstreamName: 'github',
        originalToolName: 'listRepos',
      });
    });

    it('should return undefined when there is no separator', () => {
      expect(service.resolve('listRepos')).toBeUndefined();
    });

    it('should return undefined when prefix is not registered', () => {
      expect(service.resolve('unknown_listRepos')).toBeUndefined();
    });

    it('should handle tool names with multiple underscores', () => {
      const result = service.resolve('gh_list_all_repos');

      expect(result).toEqual({
        upstreamName: 'github',
        originalToolName: 'list_all_repos',
      });
    });
  });

  describe('prefixes containing underscores', () => {
    beforeEach(() => {
      service.configure(
        [
          { name: 'my-api', url: 'http://localhost', transport: 'sse', toolPrefix: 'my_api' },
          { name: 'my', url: 'http://localhost', transport: 'sse' },
        ],
        routing,
      );
    });

    it('routes to the longest matching prefix', () => {
      expect(service.resolve('my_api_tool')).toEqual({
        upstreamName: 'my-api',
        originalToolName: 'tool',
      });
    });

    it('falls back to a shorter prefix when the longer one does not match', () => {
      expect(service.resolve('my_tool')).toEqual({ upstreamName: 'my', originalToolName: 'tool' });
    });

    it('matches only the full prefix followed by an underscore', () => {
      service.configure(
        [{ name: 'a', url: 'http://localhost', transport: 'sse', toolPrefix: 'a_b_c' }],
        routing,
      );
      expect(service.resolve('a_b_c_d')).toEqual({ upstreamName: 'a', originalToolName: 'd' });
      expect(service.resolve('a_b_d')).toBeUndefined();
    });

    it('warns when one prefix overlaps another', () => {
      const warn = vi.spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      );
      service.configure(
        [
          { name: 'api', url: 'http://localhost', transport: 'sse' },
          { name: 'v2', url: 'http://localhost', transport: 'sse', toolPrefix: 'api_v2' },
        ],
        routing,
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"api_v2"'));
    });
  });

  describe('duplicate prefixes', () => {
    it('throws when two upstreams share a toolPrefix', () => {
      expect(() =>
        service.configure(
          [
            { name: 'a', url: 'http://localhost', transport: 'sse', toolPrefix: 'x' },
            { name: 'b', url: 'http://localhost', transport: 'sse', toolPrefix: 'x' },
          ],
          routing,
        ),
      ).toThrow(/Duplicate tool prefix "x" for upstreams "a" and "b"/);
    });

    it('throws when a toolPrefix collides with another upstream name', () => {
      expect(() =>
        service.configure(
          [
            { name: 'github', url: 'http://localhost', transport: 'sse' },
            { name: 'gh2', url: 'http://localhost', transport: 'sse', toolPrefix: 'github' },
          ],
          routing,
        ),
      ).toThrow(/Duplicate tool prefix "github"/);
    });

    it('ignores disabled upstreams when checking for duplicates', () => {
      expect(() =>
        service.configure(
          [
            { name: 'a', url: 'http://localhost', transport: 'sse', toolPrefix: 'x' },
            {
              name: 'b',
              url: 'http://localhost',
              transport: 'sse',
              toolPrefix: 'x',
              enabled: false,
            },
          ],
          routing,
        ),
      ).not.toThrow();
    });
  });

  describe('buildPrefixedName', () => {
    it('should join prefix and tool name with underscore', () => {
      expect(service.buildPrefixedName('gh', 'listRepos')).toBe('gh_listRepos');
    });
  });

  describe('getPrefixForUpstream', () => {
    it('should return undefined for unknown upstream', () => {
      expect(service.getPrefixForUpstream('nonexistent')).toBeUndefined();
    });
  });
});
