import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { Tool } from '@btwld/mcp-server';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { BrowserService } from '../browser/browser.service';
import { WebContentService } from '../browser/web-content.service';
import type { FetchOptions, FetchResult } from '../interfaces/fetch-options.interface';
import { validateUrlProtocol, validateUrlsProtocol } from '../utils/url-validator';

const fetchOptionsSchema = {
  timeout: z.number().optional().default(30000).describe('Page load timeout in ms (default: 30000)'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .optional()
    .default('load')
    .describe("When navigation is considered complete: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'"),
  extractContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Intelligently extract main content with Readability (default: true)'),
  maxLength: z
    .number()
    .optional()
    .default(0)
    .describe('Maximum length of returned content in characters (default: no limit)'),
  returnHtml: z.boolean().optional().default(false).describe('Return HTML instead of Markdown (default: false)'),
  waitForNavigation: z
    .boolean()
    .optional()
    .default(false)
    .describe('Wait for additional navigation after load, useful for anti-bot redirects (default: false)'),
  navigationTimeout: z
    .number()
    .optional()
    .default(10000)
    .describe('Max time to wait for additional navigation in ms (default: 10000)'),
  disableMedia: z
    .boolean()
    .optional()
    .default(true)
    .describe('Disable loading of images, stylesheets, fonts and media (default: true)'),
  debug: z.boolean().optional().describe('Show browser window for debugging (overrides --debug flag)'),
};

function buildFetchOptions(args: Record<string, unknown>): FetchOptions {
  return {
    timeout: (args.timeout as number) ?? 30000,
    waitUntil: (args.waitUntil as FetchOptions['waitUntil']) ?? 'load',
    extractContent: (args.extractContent as boolean) ?? true,
    maxLength: (args.maxLength as number) ?? 0,
    returnHtml: (args.returnHtml as boolean) ?? false,
    waitForNavigation: (args.waitForNavigation as boolean) ?? false,
    navigationTimeout: (args.navigationTimeout as number) ?? 10000,
    disableMedia: (args.disableMedia as boolean) ?? true,
    debug: args.debug as boolean | undefined,
  };
}

@Injectable()
export class FetchTools {
  private readonly logger = new Logger(FetchTools.name);

  constructor(
    private readonly browserService: BrowserService,
    private readonly webContentService: WebContentService,
  ) {}

  @Tool({
    name: 'fetch_url',
    description: 'Retrieve web page content from a specified URL using a headless Chromium browser.',
    parameters: z.object({
      url: z
        .string()
        .describe('URL to fetch. Include the schema (http:// or https://, prefer https://)'),
      ...fetchOptionsSchema,
    }),
    annotations: { readOnlyHint: true },
  })
  async fetchUrl(args: {
    url: string;
    timeout?: number;
    waitUntil?: FetchOptions['waitUntil'];
    extractContent?: boolean;
    maxLength?: number;
    returnHtml?: boolean;
    waitForNavigation?: boolean;
    navigationTimeout?: number;
    disableMedia?: boolean;
    debug?: boolean;
  }) {
    validateUrlProtocol(args.url);

    const options = buildFetchOptions(args as Record<string, unknown>);
    const debug = this.browserService.isDebugMode(options);

    if (debug) this.logger.debug(`Debug mode enabled for URL: ${args.url}`);

    const browser = await this.browserService.createBrowser(options);
    let page = null;
    try {
      const { context, viewport } = await this.browserService.createContext(browser, options);
      page = await this.browserService.createPage(context);
      const result = await this.webContentService.processPageContent(page, args.url, options);
      return { content: [{ type: 'text' as const, text: result.content }] };
    } finally {
      await this.browserService.cleanup(browser, page, options);
    }
  }

  @Tool({
    name: 'fetch_urls',
    description:
      'Retrieve web page content from multiple URLs in parallel using a shared headless Chromium browser context.',
    parameters: z.object({
      urls: z.array(z.string()).min(1).describe('Array of URLs to fetch'),
      ...fetchOptionsSchema,
    }),
    annotations: { readOnlyHint: true },
  })
  async fetchUrls(args: {
    urls: string[];
    timeout?: number;
    waitUntil?: FetchOptions['waitUntil'];
    extractContent?: boolean;
    maxLength?: number;
    returnHtml?: boolean;
    waitForNavigation?: boolean;
    navigationTimeout?: number;
    disableMedia?: boolean;
    debug?: boolean;
  }) {
    validateUrlsProtocol(args.urls);

    const options = buildFetchOptions(args as Record<string, unknown>);
    const debug = this.browserService.isDebugMode(options);

    if (debug) this.logger.debug(`Debug mode enabled for URLs: ${args.urls.join(', ')}`);

    const browser = await this.browserService.createBrowser(options);
    try {
      const { context, viewport } = await this.browserService.createContext(browser, options);

      const results: FetchResult[] = await Promise.all(
        args.urls.map(async (url, index) => {
          const page = await this.browserService.createPage(context);
          try {
            const result = await this.webContentService.processPageContent(page, url, options);
            return { ...result, index };
          } finally {
            if (!debug) {
              await page
                .close()
                .catch((e: unknown) =>
                  this.logger.error(`Failed to close page: ${e instanceof Error ? e.message : String(e)}`),
                );
            }
          }
        }),
      );

      results.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

      const combined = results
        .map((r, i) => `[webpage ${i + 1} begin]\n${r.content}\n[webpage ${i + 1} end]`)
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: combined }] };
    } finally {
      if (!debug) {
        await browser
          .close()
          .catch((e: unknown) =>
            this.logger.error(`Failed to close browser: ${e instanceof Error ? e.message : String(e)}`),
          );
      }
    }
  }

  @Tool({
    name: 'browser_install',
    description:
      "Install Playwright Chromium browser binary. Call this if you get an error about the browser not being installed.",
    parameters: z.object({
      withDeps: z
        .boolean()
        .optional()
        .default(false)
        .describe('Install system dependencies required by Chromium (default: false)'),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force reinstall even if Chromium is already installed (default: false)'),
    }),
    annotations: { destructiveHint: true },
  })
  async browserInstall(args: { withDeps?: boolean; force?: boolean }) {
    const withDeps = args.withDeps ?? false;
    const force = args.force ?? false;

    this.logger.log('Starting installation of Chromium browser…');

    const installArgs = ['playwright', 'install'];
    if (withDeps) installArgs.push('--with-deps');
    if (force) installArgs.push('--force');
    installArgs.push('chromium');

    const result = await this.executePlaywrightInstall(installArgs);

    if (result.success) {
      const msg = `Successfully installed Chromium browser${withDeps ? ' with system dependencies' : ''}`;
      this.logger.log(msg);
      return { content: [{ type: 'text' as const, text: `✅ ${msg}\n\n${result.output}` }] };
    }

    const errMsg = `Failed to install Chromium browser: ${result.error}`;
    this.logger.error(errMsg);
    return {
      content: [
        {
          type: 'text' as const,
          text: `❌ ${errMsg}\n\nOutput:\n${result.output}\n\nError:\n${result.error}`,
        },
      ],
      isError: true,
    };
  }

  private executePlaywrightInstall(
    args: string[],
  ): Promise<{ success: boolean; output: string; error: string }> {
    return new Promise((resolve) => {
      let command: string;
      let commandArgs: string[];

      try {
        const pkgPath: string = require.resolve('playwright/package.json');
        const playwrightDir = pkgPath.replace('/package.json', '');
        const cliPath = `${playwrightDir}/cli.js`;

        if (existsSync(cliPath)) {
          command = 'node';
          commandArgs = [cliPath, ...args.filter((a) => a !== 'playwright')];
          this.logger.debug(`Using local Playwright CLI: ${cliPath}`);
        } else {
          throw new Error('CLI file not found');
        }
      } catch {
        command = 'npx';
        commandArgs = args;
        this.logger.debug('Falling back to npx playwright install');
      }

      const child = spawn(command, commandArgs, {
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code: number | null) => {
        resolve({ success: code === 0, output: stdout, error: stderr });
      });

      child.on('error', (err: Error) => {
        resolve({ success: false, output: stdout, error: err.message });
      });
    });
  }
}
