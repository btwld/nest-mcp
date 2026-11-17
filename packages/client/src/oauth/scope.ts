/** Maximum scope-token length accepted by the bounded OAuth client facade. */
export const MCP_CLIENT_OAUTH_MAX_SCOPE_LENGTH = 256;

/**
 * Returns whether `value` is one bounded RFC 6749 scope-token.
 *
 * RFC 6749 section 3.3 defines scope-token as ASCII NQCHAR: `!`, `#` through
 * `[`, or `]` through `~`. In particular, quote, backslash, whitespace, control
 * characters, and non-ASCII characters are not valid scope-token content.
 */
export function isMcpClientOAuthScopeToken(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MCP_CLIENT_OAUTH_MAX_SCOPE_LENGTH
	) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code !== 0x21 && !(code >= 0x23 && code <= 0x5b) && !(code >= 0x5d && code <= 0x7e)) {
			return false;
		}
	}
	return true;
}
