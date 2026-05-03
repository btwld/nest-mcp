import type { ElicitationTemplateOptions } from '../interfaces/elicitation-options.interface';
import { escapeHtml, renderPage } from './base.template';

export function apiKeyFormTemplate(params: {
  elicitationId: string;
  message: string;
  fieldLabel: string;
  placeholder: string;
  description?: string;
  actionUrl: string;
  options?: ElicitationTemplateOptions;
}): string {
  const description = params.description
    ? `<p>${escapeHtml(params.description)}</p>`
    : '';

  const body = `
    <h1>${escapeHtml(params.fieldLabel)}</h1>
    <p>${escapeHtml(params.message)}</p>
    ${description}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <input type="hidden" name="elicitationId" value="${escapeHtml(params.elicitationId)}" />
      <label for="apiKey">${escapeHtml(params.fieldLabel)}</label>
      <input type="password" id="apiKey" name="apiKey" placeholder="${escapeHtml(params.placeholder)}" autocomplete="off" required />
      <div class="actions">
        <button type="submit" class="primary">Submit</button>
      </div>
    </form>
  `;

  return renderPage({ title: params.fieldLabel, body, options: params.options });
}
