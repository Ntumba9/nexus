import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { ApiEnv } from '@nexus/config';
import { bearerMatches } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';
import { ENV } from '../infrastructure/tokens';
import { Public } from '../rbac/decorators';
import { MetricsService } from './metrics.service';

/**
 * `GET /metrics` in the Prometheus text format. It does not exist unless `METRICS_TOKEN` is set
 * (404, as if it were never there), and then it needs `Authorization: Bearer <token>`: request
 * counts by route are operational information, not something to publish.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Public() // not a session route: it has its own token
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() request: AppRequest): Promise<string> {
    const token = this.env.METRICS_TOKEN;
    if (!token) throw ApiError.notFound();
    if (!bearerMatches(request.headers.authorization, token)) {
      throw ApiError.unauthenticated('METRICS_UNAUTHORIZED', 'A valid metrics token is required');
    }
    return this.metrics.registry.render();
  }
}
