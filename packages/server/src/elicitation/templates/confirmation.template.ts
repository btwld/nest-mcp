import type { ElicitationTemplateOptions } from '../interfaces/elicitation-options.interface';
import { escapeHtml, renderPage } from './base.template';

export function confirmationFormTemplate(params: {
  elicitationId: string;
  title: string;
  message: string;
  warning?: string;
  confirmLabel: string;
  cancelLabel: string;
  actionUrl: string;
  options?: ElicitationTemplateOptions;
}): string {
  const warningBlock = params.warning
    ? `<div class="warning">${escapeHtml(params.warning)}</div>`
    : '';
  const body = `
    <h1>${escapeHtml(params.title)}</h1>
    <p>${escapeHtml(params.message)}</p>
    ${warningBlock}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <input type="hidden" name="elicitationId" value="${escapeHtml(params.elicitationId)}" />
      <div class="actions">
        <button type="submit" name="action" value="confirm" class="primary">${escapeHtml(params.confirmLabel)}</button>
        <button type="submit" name="action" value="cancel" class="secondary">${escapeHtml(params.cancelLabel)}</button>
      </div>
    </form>
  `;
  return renderPage({ title: params.title, body, options: params.options });
}
