import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  type Type,
  UseGuards,
} from '@nestjs/common';
import {
  ELICITATION_MODULE_OPTIONS,
  type ResolvedElicitationOptions,
} from './interfaces/elicitation-options.interface';
import { ElicitationService } from './services/elicitation.service';
import {
  apiKeyFormTemplate,
  cancelledPageTemplate,
  confirmationFormTemplate,
  errorPageTemplate,
  successPageTemplate,
} from './templates';

/**
 * Structural HTTP response shape — covers the Express/Fastify subset we need
 * (`status`, `setHeader`, `send`). Lets the controller stay framework-neutral
 * the same way our transport adapters do.
 */
interface HtmlResponse {
  status(code: number): HtmlResponse;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

interface ApiKeyFormBody {
  apiKey: string;
}

interface ConfirmFormBody {
  action: 'confirm' | 'cancel';
}

/**
 * Build a `@Controller`-decorated class with the configured endpoint paths
 * and optional guards baked in. Pattern matches our transport controller
 * factories — Nest receives a fully-decorated class, not a builder.
 */
export function createElicitationController(
  options: ResolvedElicitationOptions,
): Type<unknown> {
  const { apiPrefix, endpoints, guards = [] } = options;
  const guardDecorator = guards.length > 0 ? UseGuards(...guards) : null;

  @Controller(`${apiPrefix}/:id`)
  class ElicitationController {
    private readonly logger = new Logger(ElicitationController.name);

    constructor(
      @Inject(ELICITATION_MODULE_OPTIONS) private readonly opts: ResolvedElicitationOptions,
      private readonly service: ElicitationService,
    ) {}

    @Get(endpoints.status)
    async getStatus(@Param('id') id: string) {
      const record = await this.service.getElicitation(id);
      if (!record) throw new NotFoundException('Elicitation not found or expired');
      const result = await this.service.getResult(id);
      return {
        elicitationId: id,
        status: record.status,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        completed: result !== undefined,
        result: result
          ? { success: result.success, action: result.action, completedAt: result.completedAt }
          : undefined,
      };
    }

    @Get(endpoints.apiKey)
    async renderApiKeyForm(@Param('id') id: string, @Res() res: HtmlResponse): Promise<void> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const meta = record.metadata ?? {};
      const html = apiKeyFormTemplate({
        elicitationId: id,
        message: typeof meta.message === 'string' ? meta.message : 'Please enter your API key.',
        fieldLabel: typeof meta.fieldLabel === 'string' ? meta.fieldLabel : 'API Key',
        placeholder:
          typeof meta.placeholder === 'string' ? meta.placeholder : 'Enter your API key',
        description: typeof meta.description === 'string' ? meta.description : undefined,
        actionUrl: this.service.buildElicitationUrl(id, endpoints.apiKey),
        options: this.opts.templateOptions,
      });
      sendHtml(res, 200, html);
    }

    @Post(endpoints.apiKey)
    @HttpCode(200)
    async submitApiKeyForm(
      @Param('id') id: string,
      @Body() body: ApiKeyFormBody,
      @Res() res: HtmlResponse,
    ): Promise<void> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const apiKey = body?.apiKey?.trim();
      if (!apiKey) return this.renderError(res, 'API key is required');

      await this.service.completeElicitation({
        elicitationId: id,
        success: true,
        action: 'confirm',
        data: { apiKey },
      });
      sendHtml(
        res,
        200,
        successPageTemplate({
          title: 'API Key Received',
          message: 'Your API key has been securely received.',
          options: this.opts.templateOptions,
        }),
      );
    }

    @Get(endpoints.confirm)
    async renderConfirmationForm(
      @Param('id') id: string,
      @Res() res: HtmlResponse,
    ): Promise<void> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const meta = record.metadata ?? {};
      const html = confirmationFormTemplate({
        elicitationId: id,
        title: typeof meta.title === 'string' ? meta.title : 'Confirm Action',
        message:
          typeof meta.message === 'string' ? meta.message : 'Please confirm you want to proceed.',
        warning: typeof meta.warning === 'string' ? meta.warning : undefined,
        confirmLabel: typeof meta.confirmLabel === 'string' ? meta.confirmLabel : 'Confirm',
        cancelLabel: typeof meta.cancelLabel === 'string' ? meta.cancelLabel : 'Cancel',
        actionUrl: this.service.buildElicitationUrl(id, endpoints.confirm),
        options: this.opts.templateOptions,
      });
      sendHtml(res, 200, html);
    }

    @Post(endpoints.confirm)
    @HttpCode(200)
    async submitConfirmationForm(
      @Param('id') id: string,
      @Body() body: ConfirmFormBody,
      @Res() res: HtmlResponse,
    ): Promise<void> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const action = body?.action;
      if (action !== 'confirm' && action !== 'cancel') {
        return this.renderError(res, 'Invalid action');
      }

      const success = action === 'confirm';
      await this.service.completeElicitation({
        elicitationId: id,
        success,
        action,
        data: {},
      });
      sendHtml(
        res,
        200,
        success
          ? successPageTemplate({
              title: 'Confirmed',
              message: 'Your action has been confirmed.',
              options: this.opts.templateOptions,
            })
          : cancelledPageTemplate({
              title: 'Cancelled',
              message: 'The action has been cancelled.',
              options: this.opts.templateOptions,
            }),
      );
    }

    private renderError(res: HtmlResponse, message: string): void {
      sendHtml(
        res,
        400,
        errorPageTemplate({
          title: 'Error',
          message,
          options: this.opts.templateOptions,
        }),
      );
    }
  }

  if (guardDecorator) guardDecorator(ElicitationController);
  return ElicitationController;
}

function sendHtml(res: HtmlResponse, status: number, html: string): void {
  res.setHeader('Content-Type', 'text/html');
  res.status(status).send(html);
}
