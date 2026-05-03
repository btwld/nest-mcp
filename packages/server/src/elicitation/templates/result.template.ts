import type { ElicitationTemplateOptions } from '../interfaces/elicitation-options.interface';
import { escapeHtml, renderPage } from './base.template';

export function successPageTemplate(params: {
  title: string;
  message: string;
  options?: ElicitationTemplateOptions;
}): string {
  const body = `
    <h1>${escapeHtml(params.title)}</h1>
    <p>${escapeHtml(params.message)}</p>
    <p>You can safely close this window.</p>
  `;
  return renderPage({ title: params.title, body, options: params.options });
}

export function cancelledPageTemplate(params: {
  title: string;
  message: string;
  options?: ElicitationTemplateOptions;
}): string {
  return successPageTemplate(params);
}

export function errorPageTemplate(params: {
  title: string;
  message: string;
  options?: ElicitationTemplateOptions;
}): string {
  const body = `
    <h1>${escapeHtml(params.title)}</h1>
    <div class="warning">${escapeHtml(params.message)}</div>
  `;
  return renderPage({ title: params.title, body, options: params.options });
}
