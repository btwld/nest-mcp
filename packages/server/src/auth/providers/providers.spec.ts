import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureAdProvider } from './azure-ad.provider';
import { GitHubProvider } from './github.provider';

/** Build a `Response`-shaped stub that the provider's fetch consumes. */
function fetchOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function fetchFail(status = 400): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'failure' }),
  } as unknown as Response;
}

describe('GitHubProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds an authorization URL with the configured scope and state', () => {
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    const url = provider.getAuthorizationUrl('state-123', 'https://app.example.com/callback');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
    expect(parsed.searchParams.get('scope')).toBe('read:user user:email');
    expect(parsed.searchParams.get('state')).toBe('state-123');
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('honors a custom scope', () => {
    const provider = new GitHubProvider({
      clientId: 'cid',
      clientSecret: 'sec',
      scope: 'repo',
    });
    const url = provider.getAuthorizationUrl('s', 'https://r/');
    expect(new URL(url).searchParams.get('scope')).toBe('repo');
  });

  it('exchanges a code for a profile via the GitHub APIs', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok-abc', token_type: 'bearer' }))
      .mockResolvedValueOnce(
        fetchOk({
          id: 4242,
          login: 'octocat',
          name: 'Octocat',
          email: 'octo@example.com',
          avatar_url: 'https://avatars.githubusercontent.com/u/4242',
        }),
      );

    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    const profile = await provider.exchangeToken('the-code', 'https://app/cb');

    expect(profile).toEqual({
      id: '4242',
      login: 'octocat',
      name: 'Octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://avatars.githubusercontent.com/u/4242',
    });

    const [tokenCall, profileCall] = fetchMock.mock.calls;
    expect(tokenCall[0]).toBe('https://github.com/login/oauth/access_token');
    expect((tokenCall[1] as { method: string }).method).toBe('POST');
    expect(profileCall[0]).toBe('https://api.github.com/user');
    const profileHeaders = (profileCall[1] as { headers: Record<string, string> }).headers;
    expect(profileHeaders.Authorization).toBe('Bearer tok-abc');
    expect(profileHeaders['User-Agent']).toBe('@nest-mcp/server');
  });

  it('returns null when the token endpoint fails', async () => {
    fetchMock.mockResolvedValueOnce(fetchFail(401));
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('bad', 'https://r/')).toBeNull();
  });

  it('returns null when the token response lacks an access_token', async () => {
    fetchMock.mockResolvedValueOnce(fetchOk({ error: 'invalid_grant' }));
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('bad', 'https://r/')).toBeNull();
  });

  it('returns null when the userinfo endpoint fails', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok' }))
      .mockResolvedValueOnce(fetchFail(403));
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('c', 'https://r/')).toBeNull();
  });

  it('falls back to login when name is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok' }))
      .mockResolvedValueOnce(fetchOk({ id: 1, login: 'just-login' }));
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('c', 'https://r/')).toMatchObject({
      id: '1',
      name: 'just-login',
    });
  });

  it('validateUser pulls code + redirect_uri from req.query', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok' }))
      .mockResolvedValueOnce(fetchOk({ id: 1, login: 'l' }));
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    const profile = await provider.validateUser({
      query: { code: 'abc', redirect_uri: 'https://app/cb' },
    });
    expect(profile?.id).toBe('1');
  });

  it('validateUser returns null when code or redirect_uri is missing', async () => {
    const provider = new GitHubProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.validateUser({})).toBeNull();
    expect(await provider.validateUser({ query: { code: 'abc' } })).toBeNull();
    expect(await provider.validateUser({ query: { redirect_uri: 'https://r/' } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AzureAdProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the `common` tenant by default in both endpoints', () => {
    const provider = new AzureAdProvider({ clientId: 'cid', clientSecret: 'sec' });
    const url = provider.getAuthorizationUrl('s', 'https://r/');
    expect(url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  });

  it('honors a tenant override', () => {
    const provider = new AzureAdProvider({
      clientId: 'cid',
      clientSecret: 'sec',
      tenant: 'contoso.onmicrosoft.com',
    });
    const url = provider.getAuthorizationUrl('s', 'https://r/');
    expect(url).toContain('https://login.microsoftonline.com/contoso.onmicrosoft.com');
  });

  it('exchanges a code via the v2.0 token endpoint and Microsoft Graph /me', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok-aad' }))
      .mockResolvedValueOnce(
        fetchOk({
          id: 'graph-id',
          oid: 'object-id',
          mail: 'user@contoso.com',
          userPrincipalName: 'user@contoso.com',
          displayName: 'Real Name',
        }),
      );

    const provider = new AzureAdProvider({
      clientId: 'cid',
      clientSecret: 'sec',
      tenant: 'tenant-guid',
    });
    const profile = await provider.exchangeToken('code', 'https://r/');
    expect(profile).toEqual({
      id: 'graph-id',
      email: 'user@contoso.com',
      name: 'Real Name',
      tenantId: undefined,
    });

    const [tokenCall] = fetchMock.mock.calls;
    expect(tokenCall[0]).toBe('https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token');
  });

  it('falls back to userPrincipalName when mail is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchOk({ access_token: 'tok-aad' }))
      .mockResolvedValueOnce(fetchOk({ oid: 'oid', userPrincipalName: 'a@b.com' }));
    const provider = new AzureAdProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('c', 'https://r/')).toMatchObject({
      id: 'oid',
      email: 'a@b.com',
    });
  });

  it('returns null when token exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(fetchFail(400));
    const provider = new AzureAdProvider({ clientId: 'cid', clientSecret: 'sec' });
    expect(await provider.exchangeToken('bad', 'https://r/')).toBeNull();
  });
});
