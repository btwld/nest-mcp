/** View model handed to a consent renderer; every field is display-only. */
export interface McpConsentViewModel {
	readonly clientName: string;
	/** Host component of the client_id URL (or the raw id for registered clients). */
	readonly clientIdHost: string;
	/** Host component of the redirect_uri the code would be delivered to. */
	readonly redirectHost: string;
	readonly scopes: readonly string[];
	readonly resource: string;
	/** True when every redirect URI is loopback; the page must warn. */
	readonly loopbackOnly: boolean;
	/** Opaque form fields the renderer must echo back unchanged. */
	readonly formAction: string;
	readonly transactionId: string;
	readonly csrfToken: string;
}

/** Renders the consent screen as a complete HTTP `Response`. */
export type McpConsentRenderer = (view: McpConsentViewModel) => Response | Promise<Response>;

const CONSENT_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Default consent renderer: a minimal, self-contained HTML page. It escapes
 * every dynamic value, ships a strict CSP, never loads `logo_uri` (a second
 * SSRF surface), and displays exactly the fields the spec requires — client
 * name, client_id host, redirect host, scopes, and a loopback warning.
 */
export function renderDefaultConsent(view: McpConsentViewModel): Response {
	const scopeItems =
		view.scopes.length === 0
			? "<li><em>no scopes requested</em></li>"
			: view.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
	const loopbackWarning = view.loopbackOnly
		? `<p class="warn">This client only accepts tokens on a loopback address on this device.</p>`
		: "";
	const clientName = sanitizeDisplayText(view.clientName);
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(clientName)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
.card{border:1px solid #ddd;border-radius:12px;padding:1.5rem}
.host{color:#555}
.warn{color:#a00;font-weight:600}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;cursor:pointer}
.approve{background:#1a56db;color:#fff}
.deny{background:#eee;color:#111;margin-left:.5rem}
ul{padding-left:1.2rem}
</style>
</head>
<body>
<div class="card">
<h1>Authorize access</h1>
<p><strong>${escapeHtml(clientName)}</strong> <span class="host">(${escapeHtml(view.clientIdHost)})</span> is requesting access to <span class="host">${escapeHtml(view.resource)}</span>.</p>
<p>Tokens will be delivered to <span class="host">${escapeHtml(view.redirectHost)}</span>.</p>
${loopbackWarning}
<p>Requested scopes:</p>
<ul>${scopeItems}</ul>
<form method="post" action="${escapeHtml(view.formAction)}">
<input type="hidden" name="tx" value="${escapeHtml(view.transactionId)}">
<input type="hidden" name="csrf" value="${escapeHtml(view.csrfToken)}">
<button class="approve" type="submit" name="action" value="approve">Approve</button>
<button class="deny" type="submit" name="action" value="deny">Deny</button>
</form>
</div>
</body>
</html>`;
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": CONSENT_CSP,
			"x-frame-options": "DENY",
			// same-origin keeps a Referer on the page's own POST as a CSRF fallback
			// while still withholding it from cross-origin navigations.
			"referrer-policy": "same-origin",
			"cache-control": "no-store",
		},
	});
}

/**
 * Strips control, format, and line/paragraph-separator characters (including
 * bidi overrides) from untrusted display text and bounds its length, so a
 * crafted `client_name` cannot spoof the consent prompt even once escaped.
 */
export function sanitizeDisplayText(value: string, maxLength = 200): string {
	// eslint-disable-next-line no-control-regex
	const stripped = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
	return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
