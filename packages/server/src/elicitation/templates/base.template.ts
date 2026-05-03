import type { ElicitationTemplateOptions } from '../interfaces/elicitation-options.interface';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape HTML-significant characters. Used on every value rendered into an
 * HTML attribute or text node to prevent injection from metadata fields.
 * Single-pass to keep ordering straightforward (any `&amp;` produced by the
 * `&` replacement isn't re-escaped) — matters when a value already contains
 * partial HTML entities.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Render the standard HTML shell shared by every elicitation page. Inlines
 * the `templateOptions.customCss` block when provided.
 */
export function renderPage({
  title,
  body,
  options = {},
}: {
  title: string;
  body: string;
  options?: ElicitationTemplateOptions;
}): string {
  const appName = escapeHtml(options.appName ?? 'MCP Server');
  const primary = options.primaryColor ?? '#007bff';
  const customCss = options.customCss ?? '';
  const logoBlock = options.logoUrl
    ? `<img class="logo" src="${escapeHtml(options.logoUrl)}" alt="${appName}" />`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — ${appName}</title>
  <style>
    :root { --primary: ${primary}; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f7fa;
      color: #1f2937;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      padding: 2rem;
      width: 100%;
      max-width: 32rem;
    }
    .logo { display: block; max-height: 48px; margin: 0 auto 1.25rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
    p { margin: 0.5rem 0; line-height: 1.5; color: #4b5563; }
    label { display: block; font-weight: 600; margin: 1rem 0 0.4rem; }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.8rem;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 1rem;
      box-sizing: border-box;
    }
    input:focus { outline: 2px solid var(--primary); outline-offset: 1px; }
    .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
    button {
      flex: 1;
      padding: 0.7rem 1rem;
      border-radius: 6px;
      border: 0;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary { background: var(--primary); color: #fff; }
    button.secondary { background: #e5e7eb; color: #1f2937; }
    button:hover { filter: brightness(0.95); }
    .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 4px; }
    .footer { text-align: center; color: #9ca3af; font-size: 0.85rem; margin-top: 1.5rem; }
    ${customCss}
  </style>
</head>
<body>
  <div class="card">
    ${logoBlock}
    ${body}
    <p class="footer">${appName}</p>
  </div>
</body>
</html>`;
}
