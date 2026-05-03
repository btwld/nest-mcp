import { describe, expect, it } from 'vitest';
import {
  apiKeyFormTemplate,
  cancelledPageTemplate,
  confirmationFormTemplate,
  errorPageTemplate,
  escapeHtml,
  successPageTemplate,
} from './index';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("xss")</script>&'`)).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&#39;',
    );
  });

  it('passes through ordinary text untouched', () => {
    expect(escapeHtml('Hello, world!')).toBe('Hello, world!');
  });
});

describe('apiKeyFormTemplate', () => {
  it('renders the form with escaped metadata fields', () => {
    const html = apiKeyFormTemplate({
      elicitationId: 'eid-<x>',
      message: 'Need <key>',
      fieldLabel: 'API "Key"',
      placeholder: "type 'here'",
      actionUrl: 'https://example.com/post',
    });
    expect(html).toContain('value="eid-&lt;x&gt;"');
    expect(html).toContain('Need &lt;key&gt;');
    expect(html).toContain('API &quot;Key&quot;');
    expect(html).toContain('type &#39;here&#39;');
    expect(html).toContain('action="https://example.com/post"');
    expect(html).toContain('autocomplete="off"');
  });
});

describe('confirmationFormTemplate', () => {
  it('renders confirm/cancel buttons with the correct values', () => {
    const html = confirmationFormTemplate({
      elicitationId: 'eid',
      title: 'Pay $5',
      message: 'Charge your card?',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      actionUrl: 'https://example.com/post',
    });
    expect(html).toContain('value="eid"');
    expect(html).toContain('Pay $5');
    expect(html).toContain('Charge your card?');
    expect(html).toContain('name="action" value="confirm"');
    expect(html).toContain('name="action" value="cancel"');
  });

  it('omits the warning block when no warning is set', () => {
    const html = confirmationFormTemplate({
      elicitationId: 'eid',
      title: 'T',
      message: 'M',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      actionUrl: '/x',
    });
    expect(html).not.toContain('class="warning"');
  });

  it('renders an escaped warning when supplied', () => {
    const html = confirmationFormTemplate({
      elicitationId: 'eid',
      title: 'T',
      message: 'M',
      warning: '<bad>',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      actionUrl: '/x',
    });
    expect(html).toContain('class="warning"');
    expect(html).toContain('&lt;bad&gt;');
  });
});

describe('result page templates', () => {
  it('successPageTemplate renders title and message', () => {
    const html = successPageTemplate({ title: 'Done', message: 'OK' });
    expect(html).toContain('Done');
    expect(html).toContain('OK');
  });

  it('cancelledPageTemplate renders the same shell as success', () => {
    const html = cancelledPageTemplate({ title: 'Stop', message: 'Aborted' });
    expect(html).toContain('Stop');
    expect(html).toContain('Aborted');
  });

  it('errorPageTemplate uses the warning block to highlight the message', () => {
    const html = errorPageTemplate({ title: 'Oops', message: 'broke' });
    expect(html).toContain('class="warning"');
    expect(html).toContain('broke');
  });
});

describe('template options', () => {
  it('honors appName and primaryColor', () => {
    const html = successPageTemplate({
      title: 'Done',
      message: 'OK',
      options: { appName: 'My App', primaryColor: '#abcdef' },
    });
    expect(html).toContain('My App');
    expect(html).toContain('#abcdef');
  });

  it('embeds customCss into the style block', () => {
    const html = successPageTemplate({
      title: 'Done',
      message: 'OK',
      options: { customCss: '.card { background: pink }' },
    });
    expect(html).toContain('.card { background: pink }');
  });

  it('renders the logo block when logoUrl is set', () => {
    const html = successPageTemplate({
      title: 'Done',
      message: 'OK',
      options: { logoUrl: 'https://example.com/logo.png' },
    });
    expect(html).toContain('<img class="logo"');
    expect(html).toContain('src="https://example.com/logo.png"');
  });
});
