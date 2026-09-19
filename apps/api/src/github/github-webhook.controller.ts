import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AppRequest } from '../common/request-context';
import { UuidParamPipe } from '../common/zod.pipe';
import { Public } from '../rbac/decorators';
import { GitHubWebhookService, type WebhookOutcome } from './github-webhook.service';

const idPipe = new UuidParamPipe();

/**
 * Public endpoint for GitHub. It has no session: the request is authenticated by the HMAC
 * signature of its raw body, verified against the integration's own secret.
 */
@ApiTags('github')
@Controller('webhooks/github')
export class GitHubWebhookController {
  constructor(@Inject(GitHubWebhookService) private readonly webhooks: GitHubWebhookService) {}

  @Public()
  @Post(':integrationId')
  @HttpCode(202)
  @ApiOperation({ summary: 'Receive a GitHub webhook delivery (signature-authenticated)' })
  async receive(
    @Param('integrationId', idPipe) integrationId: string,
    @Req() request: RawBodyRequest<AppRequest>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-github-event') eventType: string | undefined,
  ): Promise<{ status: WebhookOutcome }> {
    const status = await this.webhooks.receive({
      integrationId,
      rawBody: request.rawBody,
      body: request.body as unknown,
      isJson: Boolean(request.is('application/json')),
      signature,
      deliveryId,
      eventType,
      ip: request.ip ?? 'unknown',
    });
    return { status };
  }
}
