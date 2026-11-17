import type { AuthInfo } from "@modelcontextprotocol/server";

export interface McpOAuthPrincipalClaims {
	readonly subject?: string;
	readonly tenantId?: string;
}

export interface McpOAuthPrincipalClaimsOptions {
	/** Claim key holding the verified subject inside `AuthInfo.extra.claims`. */
	readonly subject?: string;
	/** Claim key holding the verified tenant inside `AuthInfo.extra.claims`. */
	readonly tenantId?: string;
}

/**
 * Builds the principal-claims resolver consumed by
 * `McpServerDefinition.principalClaims`: it reads only the allowlisted
 * `AuthInfo.extra.claims` object placed there by this package's verifiers
 * and projects at most `{subject, tenantId}` — never arbitrary extras.
 */
export function createMcpOAuthPrincipalClaims(
	options?: McpOAuthPrincipalClaimsOptions,
): (authInfo: Readonly<AuthInfo>) => McpOAuthPrincipalClaims {
	const subjectKey = options?.subject ?? "sub";
	const tenantKey = options?.tenantId ?? "tid";
	return (authInfo) => {
		const claims = claimsOf(authInfo);
		const subject = claims?.[subjectKey];
		const tenantId = claims?.[tenantKey];
		return {
			...(typeof subject === "string" && subject.trim().length > 0 ? { subject } : {}),
			...(typeof tenantId === "string" && tenantId.trim().length > 0 ? { tenantId } : {}),
		};
	};
}

function claimsOf(authInfo: Readonly<AuthInfo>): Record<string, unknown> | undefined {
	const claims = authInfo.extra?.["claims"];
	if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return claims as Record<string, unknown>;
}
