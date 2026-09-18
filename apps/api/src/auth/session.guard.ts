import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error';
import { readCookie } from '../common/cookies';
import type { AppRequest } from '../common/request-context';
import { IS_PUBLIC_KEY } from '../rbac/decorators';
import { SESSION_COOKIE } from './session-cookie';
import { SessionService } from './session.service';

/** Global guard (default-deny): every route requires a valid session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) throw ApiError.unauthenticated();

    const auth = await this.sessions.authenticate(token);
    if (!auth) throw ApiError.unauthenticated();

    request.auth = auth;
    return true;
  }
}
