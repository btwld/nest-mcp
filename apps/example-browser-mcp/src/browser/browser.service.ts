import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { FetchOptions } from '../interfaces/fetch-options.interface';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private sharedBrowser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  isDebugMode(options: Pick<FetchOptions, 'debug'>): boolean {
    if (options.debug !== undefined) return options.debug;
    return process.argv.includes('--debug');
  }

  private randomFrom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private async setupAntiDetection(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      delete (window as unknown as Record<string, unknown>).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as unknown as Record<string, unknown>).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as unknown as Record<string, unknown>).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };

      Object.defineProperty(screen, 'width', { value: window.innerWidth });
      Object.defineProperty(screen, 'height', { value: window.innerHeight });
      Object.defineProperty(screen, 'availWidth', { value: window.innerWidth });
      Object.defineProperty(screen, 'availHeight', { value: window.innerHeight });

      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', {
        get: () => Array.from({ length: 5 + Math.floor(Math.random() * 5) }, (_, i) => ({
          name: `Plugin ${i}`,
          description: `Description ${i}`,
          filename: `plugin${i}.dll`,
        })),
      });
    });
  }

  private async setupMediaHandling(context: BrowserContext, options: FetchOptions): Promise<void> {
    if (options.disableMedia) {
      await context.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          await route.abort();
        } else {
          await route.continue();
        }
      });
    }
  }

  /** Returns the shared browser, launching it if not yet started. */
  async getBrowser(): Promise<Browser> {
    if (this.sharedBrowser?.isConnected()) {
      return this.sharedBrowser;
    }

    if (!this.launchPromise) {
      this.launchPromise = this.launchBrowser().then((browser) => {
        this.sharedBrowser = browser;
        this.launchPromise = null;
        browser.on('disconnected', () => {
          this.sharedBrowser = null;
          this.logger.warn('Browser disconnected — will relaunch on next request');
        });
        return browser;
      });
    }

    return this.launchPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    this.logger.log('Launching shared Chromium browser…');
    try {
      return await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-webgl',
          '--disable-infobars',
          '--disable-extensions',
        ],
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      const isMissing =
        msg.includes("executable doesn't exist") ||
        msg.includes('browser not found') ||
        msg.includes('could not find browser') ||
        msg.includes('failed to launch browser') ||
        msg.includes('browser executable not found') ||
        msg.includes('chromium browser not found');

      if (isMissing) {
        const enhanced = new Error(
          `Browser not installed. ${error instanceof Error ? error.message : msg}\n\n` +
            `💡 To fix this, call the 'browser_install' tool to install the required browser binaries.`,
        );
        enhanced.name = 'BrowserNotInstalledError';
        throw enhanced;
      }
      throw error;
    }
  }

  async createContext(
    options: FetchOptions,
  ): Promise<{ context: BrowserContext; viewport: { width: number; height: number } }> {
    const browser = await this.getBrowser();
    const viewport = this.randomFrom(VIEWPORTS);

    const context = await browser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      userAgent: this.randomFrom(USER_AGENTS),
      viewport,
      deviceScaleFactor: Math.random() > 0.5 ? 1 : 2,
      isMobile: false,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
      acceptDownloads: true,
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        DNT: '1',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
    });

    await this.setupAntiDetection(context);
    await this.setupMediaHandling(context, options);

    return { context, viewport };
  }

  async createPage(context: BrowserContext): Promise<Page> {
    return context.newPage();
  }

  async cleanup(context: BrowserContext, page: Page | null, options: FetchOptions): Promise<void> {
    if (this.isDebugMode(options)) {
      this.logger.debug('Debug mode: context/page kept open');
      return;
    }
    if (page) {
      await page.close().catch((e: unknown) => {
        this.logger.error(`Failed to close page: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    await context.close().catch((e: unknown) => {
      this.logger.error(`Failed to close context: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sharedBrowser) {
      this.logger.log('Closing shared browser…');
      await this.sharedBrowser.close().catch(() => {});
      this.sharedBrowser = null;
    }
  }
}
