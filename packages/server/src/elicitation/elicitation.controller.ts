import {
  Body,
  Controller,
  Get,
  Header,
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
import { asString } from '../utils/coerce';
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
 * Minimal status-setter contract — covers the subset of Express's
 * `Response.status()` and Fastify's `FastifyReply.status()` we actually use
 * with `@Res({ passthrough: true })`. Nest still owns the response write;
 * we only override the status code on error paths.
 */
interface StatusSettable {
  status(code: number): unknown;
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
export function createElicitationController(options: ResolvedElicitationOptions): Type<unknown> {
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
    @Header('Content-Type', 'text/html')
    async renderApiKeyForm(
      @Param('id') id: string,
      @Res({ passthrough: true }) res: StatusSettable,
    ): Promise<string> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const meta = record.metadata ?? {};
      return apiKeyFormTemplate({
        elicitationId: id,
        message: asString(meta.message) ?? 'Please enter your API key.',
        fieldLabel: asString(meta.fieldLabel) ?? 'API Key',
        placeholder: asString(meta.placeholder) ?? 'Enter your API key',
        description: asString(meta.description),
        actionUrl: this.service.buildElicitationUrl(id, endpoints.apiKey),
        options: this.opts.templateOptions,
      });
    }

    @Post(endpoints.apiKey)
    @HttpCode(200)
    @Header('Content-Type', 'text/html')
    async submitApiKeyForm(
      @Param('id') id: string,
      @Body() body: ApiKeyFormBody,
      @Res({ passthrough: true }) res: StatusSettable,
    ): Promise<string> {
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
      return successPageTemplate({
        title: 'API Key Received',
        message: 'Your API key has been securely received.',
        options: this.opts.templateOptions,
      });
    }

    @Get(endpoints.confirm)
    @Header('Content-Type', 'text/html')
    async renderConfirmationForm(
      @Param('id') id: string,
      @Res({ passthrough: true }) res: StatusSettable,
    ): Promise<string> {
      const record = await this.service.getElicitation(id);
      if (!record) return this.renderError(res, 'Elicitation not found or expired');
      if (record.status === 'complete') {
        return this.renderError(res, 'This elicitation has already been completed');
      }
      const meta = record.metadata ?? {};
      return confirmationFormTemplate({
        elicitationId: id,
        title: asString(meta.title) ?? 'Confirm Action',
        message: asString(meta.message) ?? 'Please confirm you want to proceed.',
        warning: asString(meta.warning),
        confirmLabel: asString(meta.confirmLabel) ?? 'Confirm',
        cancelLabel: asString(meta.cancelLabel) ?? 'Cancel',
        actionUrl: this.service.buildElicitationUrl(id, endpoints.confirm),
        options: this.opts.templateOptions,
      });
    }

    @Post(endpoints.confirm)
    @HttpCode(200)
    @Header('Content-Type', 'text/html')
    async submitConfirmationForm(
      @Param('id') id: string,
      @Body() body: ConfirmFormBody,
      @Res({ passthrough: true }) res: StatusSettable,
    ): Promise<string> {
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
      return success
        ? successPageTemplate({
            title: 'Confirmed',
            message: 'Your action has been confirmed.',
            options: this.opts.templateOptions,
          })
        : cancelledPageTemplate({
            title: 'Cancelled',
            message: 'The action has been cancelled.',
            options: this.opts.templateOptions,
          });
    }

    /**
     * Render the error page and signal the framework to write a 400 status.
     * Returning the HTML lets Nest commit the response normally.
     */
    private renderError(res: StatusSettable, message: string): string {
      res.status(400);
      return errorPageTemplate({
        title: 'Error',
        message,
        options: this.opts.templateOptions,
      });
    }
  }

  if (guardDecorator) guardDecorator(ElicitationController);
  return ElicitationController;
}
