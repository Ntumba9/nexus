import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ApiEnv } from '@nexus/config';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type MeResponse,
  type RegisterInput,
} from '@nexus/shared';
import type { Response } from 'express';
import { ApiError } from '../common/api-error';
import { readCookie } from '../common/cookies';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ENV } from '../infrastructure/tokens';
import { AuthenticatedOnly, Public } from '../rbac/decorators';
import { AuthRateLimits } from './auth-rate-limits';
import { AuthService, type ClientMeta } from './auth.service';
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from './session-cookie';

function clientMeta(request: AppRequest): ClientMeta {
  return { ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthRateLimits) private readonly limits: AuthRateLimits,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.secureCookie = env.COOKIE_SECURE
      ? env.COOKIE_SECURE === 'true'
      : env.NODE_ENV === 'production';
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an account and start a session' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    await this.limits.beforeRegister(request.ip);
    const { me, session } = await this.auth.register(body, clientMeta(request));
    setSessionCookie(response, session.token, session.expiresAt, this.secureCookie);
    return me;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in and start a session' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    await this.limits.beforeLogin(request.ip, body.email);
    const previous = readCookie(request.headers.cookie, SESSION_COOKIE);
    const { me, session } = await this.auth.login(body, clientMeta(request), previous);
    setSessionCookie(response, session.token, session.expiresAt, this.secureCookie);
    return me;
  }

  @AuthenticatedOnly()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) await this.auth.logout(token);
    clearSessionCookie(response, this.secureCookie);
  }

  @AuthenticatedOnly()
  @Get('me')
  @ApiOperation({ summary: 'The current user and their organisation memberships' })
  async me(@Req() request: AppRequest): Promise<MeResponse> {
    if (!request.auth) throw ApiError.unauthenticated();
    return this.auth.me(request.auth.user);
  }
}
