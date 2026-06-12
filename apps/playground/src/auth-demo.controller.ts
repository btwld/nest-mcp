import { Controller, Get } from '@nestjs/common';
import { DEMO_SCOPES, DEMO_TOKEN } from './demo-token.verifier';

@Controller('auth/demo')
export class AuthDemoController {
  /**
   * The playground is a resource server only — tokens come from an
   * authorization server, not from the MCP server. This endpoint hands out
   * the static demo token that `DemoTokenVerifier` accepts.
   */
  @Get('test-token')
  getTestToken() {
    return {
      access_token: DEMO_TOKEN,
      token_type: 'Bearer',
      scopes: DEMO_SCOPES,
      usage: `curl -H "Authorization: Bearer ${DEMO_TOKEN}" -X POST http://localhost:3000/mcp`,
      discovery: 'curl http://localhost:3000/.well-known/oauth-protected-resource/mcp',
    };
  }
}
