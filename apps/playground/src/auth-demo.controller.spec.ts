import { describe, expect, it } from 'vitest';
import { AuthDemoController } from './auth-demo.controller';
import { DEMO_SCOPES, DEMO_TOKEN } from './demo-token.verifier';

describe('AuthDemoController', () => {
  it('hands out the static demo token with usage instructions', () => {
    const result = new AuthDemoController().getTestToken();

    expect(result.access_token).toBe(DEMO_TOKEN);
    expect(result.token_type).toBe('Bearer');
    expect(result.scopes).toEqual(DEMO_SCOPES);
    expect(result.usage).toContain(`Bearer ${DEMO_TOKEN}`);
    expect(result.discovery).toContain('/.well-known/oauth-protected-resource/mcp');
  });
});
