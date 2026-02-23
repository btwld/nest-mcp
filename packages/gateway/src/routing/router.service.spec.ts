import { RouterService } from './router.service';
import type { UpstreamConfig } from '../upstream/upstream.interface';
import type { RoutingConfig } from './route-config.interface';

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
        { name: 'github', url: 'http://localhost', transport: 'sse', toolPrefix: 'gh', enabled: false },
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
