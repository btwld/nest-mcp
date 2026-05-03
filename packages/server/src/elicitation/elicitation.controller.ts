import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { asString } from '../utils/coerce';
import {
  ELICITATION_MODULE_OPTIONS,
  type ResolvedElicitationOptions,
} from './interfaces/elicitation-options.interface';
import { ElicitationGuardComposite } from './services/elicitation-guard.composite';
import { ElicitationService } from './services/elicitation.service';
import {
  apiKeyFormTemplate,
  cancelledPageTemplate,
  confirmationFormTemplate,
  errorPageTemplate,
  successPageTemplate,
} from './templates';

const PATH_API_KEY = 'api-key';
const PATH_CONFIRM = 'confirm';
const PATH_STATUS = 'status';

/** Status-setter contract — covers Express's `Response.status()` and Fastify's `FastifyReply.status()`. */
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
 * Static elicitation controller. Path prefix is applied externally via
 * `RouterModule.register({ path: apiPrefix, module: McpElicitationModule })`
 * so the controller stays decoration-only — no class factory.
 *
 * `@UseGuards(ElicitationGuardComposite)` defers guard composition to a
 * runtime composite that reads `ElicitationModuleOptions.guards`.
 */
@Controller(':id')
@UseGuards(ElicitationGuardComposite)
export class ElicitationController {
  constructor(
    @Inject(ELICITATION_MODULE_OPTIONS) private readonly opts: ResolvedElicitationOptions,
    private readonly service: ElicitationService,
  ) {}

  @Get(PATH_STATUS)
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

  @Get(PATH_API_KEY)
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
      actionUrl: this.service.buildElicitationUrl(id, PATH_API_KEY),
      options: this.opts.templateOptions,
    });
  }

  @Post(PATH_API_KEY)
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

  @Get(PATH_CONFIRM)
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
      actionUrl: this.service.buildElicitationUrl(id, PATH_CONFIRM),
      options: this.opts.templateOptions,
    });
  }

  @Post(PATH_CONFIRM)
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
