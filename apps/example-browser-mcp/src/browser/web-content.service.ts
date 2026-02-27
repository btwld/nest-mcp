import { Injectable, Logger } from '@nestjs/common';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
// @ts-ignore
import { gfm } from 'turndown-plugin-gfm';
import type { FetchOptions, FetchResult } from '../interfaces/fetch-options.interface';

@Injectable()
export class WebContentService {
  private readonly logger = new Logger(WebContentService.name);

  async processPageContent(page: any, url: string, options: FetchOptions): Promise<FetchResult> {
    try {
      page.setDefaultTimeout(options.timeout);

      this.logger.log(`Navigating to URL: ${url}`);
      try {
        await page.goto(url, { timeout: options.timeout, waitUntil: options.waitUntil });
      } catch (gotoError: unknown) {
        const msg = gotoError instanceof Error ? gotoError.message : '';
        if (msg.toLowerCase().includes('timeout')) {
          this.logger.warn(`Navigation timeout: ${msg}. Attempting to retrieve content anyway…`);
          try {
            const { pageTitle, html } = await this.safelyGetPageInfo(page, url);
            if (html?.trim().length) {
              const processedContent = await this.processContent(html, url, options);
              return {
                success: true,
                content: `Title: ${pageTitle}\nURL: ${url}\nContent:\n\n${processedContent}`,
              };
            }
          } catch {
            // fall through to original error
          }
        }
        throw gotoError;
      }

      if (options.waitForNavigation) {
        this.logger.log('Waiting for possible navigation/redirection…');
        try {
          await Promise.race([
            page.waitForNavigation({ timeout: options.navigationTimeout, waitUntil: options.waitUntil }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Navigation timeout')), options.navigationTimeout),
            ),
          ])
            .then(() => this.logger.log('Page navigated successfully'))
            .catch((e: unknown) =>
              this.logger.warn(`No navigation or timeout: ${e instanceof Error ? e.message : String(e)}`),
            );
        } catch (e: unknown) {
          this.logger.error(`Error waiting for navigation: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await this.ensurePageStability(page, options);

      const { pageTitle, html } = await this.safelyGetPageInfo(page, url);

      if (!html) {
        this.logger.warn('Browser returned empty content');
        return {
          success: false,
          content: `Title: Error\nURL: ${url}\nContent:\n\n<error>Failed to retrieve web page content: Browser returned empty content</error>`,
          error: 'Browser returned empty content',
        };
      }

      this.logger.log(`Successfully retrieved content, length: ${html.length}`);

      const processedContent = await this.processContent(html, url, options);

      return {
        success: true,
        content: `Title: ${pageTitle}\nURL: ${url}\nContent:\n\n${processedContent}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error processing ${url}: ${errorMessage}`);
      return {
        success: false,
        content: `Title: Error\nURL: ${url}\nContent:\n\n<error>Failed to retrieve web page content: ${errorMessage}</error>`,
        error: errorMessage,
      };
    }
  }

  private async ensurePageStability(page: any, options: FetchOptions): Promise<void> {
    try {
      await page.waitForFunction(() => window.document.readyState === 'complete', {
        timeout: options.timeout,
      });
      await page.waitForTimeout(500);
      this.logger.debug('Page has stabilized');
    } catch (e: unknown) {
      this.logger.warn(`Error ensuring page stability: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async safelyGetPageInfo(
    page: any,
    url: string,
    retries = 3,
  ): Promise<{ pageTitle: string; html: string }> {
    let pageTitle = 'Untitled';
    let html = '';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        pageTitle = await page.title();
        html = await page.content();
        return { pageTitle, html };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Execution context was destroyed') && attempt < retries) {
          this.logger.warn(`Context destroyed, retrying (${attempt}/${retries})…`);
          await new Promise((r) => setTimeout(r, 1000));
          await this.ensurePageStability(page, { timeout: 30000 } as FetchOptions);
        } else {
          this.logger.error(`Error getting page info for ${url}: ${msg}`);
          throw e;
        }
      }
    }

    return { pageTitle, html };
  }

  private async processContent(html: string, url: string, options: FetchOptions): Promise<string> {
    let content = html;

    if (options.extractContent) {
      this.logger.log('Extracting main content with Readability');
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM(html, { url, virtualConsole });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        this.logger.warn('Could not extract main content, using full HTML');
      } else {
        content = article.content;
        this.logger.log(`Extracted main content, length: ${content.length}`);
      }
    }

    if (!options.returnHtml) {
      this.logger.log('Converting to Markdown');
      const turndown = new TurndownService();
      turndown.use(gfm);
      content = turndown.turndown(content);
      this.logger.log(`Converted to Markdown, length: ${content.length}`);
    }

    if (options.maxLength > 0 && content.length > options.maxLength) {
      this.logger.log(`Truncating content to ${options.maxLength} characters`);
      content = content.substring(0, options.maxLength);
    }

    return content;
  }
}
