import type { ClientContext } from '../interfaces/mcp-exposure.interface';

/**
 * Anthropic beta header identifier that gates the Tool Search Tool feature.
 * Lives as a constant in the library so consumers don't embed the string —
 * when Anthropic rotates the identifier or GAs the feature, we ship a patch.
 */
export const ANTHROPIC_ADVANCED_TOOL_USE_BETA = 'advanced-tool-use-2025-11-20';

/**
 * Capability detection for exposure strategies. Uses explicit client signals
 * (beta headers, capability declarations) rather than model-name regex — the
 * header is what the Anthropic API itself checks, and it carries forward
 * across model generations automatically.
 */
export const clientSupports = {
  /**
   * Returns true if the client has declared support for Anthropic's Tool
   * Search Tool beta by sending the `anthropic-beta: advanced-tool-use-2025-11-20`
   * header.
   */
  search(ctx: ClientContext): boolean {
    return ctx.betaHeaders?.includes(ANTHROPIC_ADVANCED_TOOL_USE_BETA) ?? false;
  },

  /**
   * Reserved for Code Mode clients (Cloudflare Agents etc). Returns false
   * until a stable capability signal is specified.
   */
  codeMode(_ctx: ClientContext): boolean {
    return false;
  },
};
