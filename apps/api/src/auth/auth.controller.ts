import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ApiEnv } from '@nexus/config';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginInput,
  type MeResponse,
  type RegisterInput,
  type ResetPasswordInput,
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
  private readonly registrationEnabled: boolean;

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthRateLimits) private readonly limits: AuthRateLimits,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.secureCookie = env.COOKIE_SECURE
      ? env.COOKIE_SECURE === 'true'
      : env.NODE_ENV === 'production';
    this.registrationEnabled = env.REGISTRATION_ENABLED === 'true';
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
    // Checked first: a closed door answers the same to everyone and spends no rate-limit budget.
    if (!this.registrationEnabled) {
      throw ApiError.forbidden('REGISTRATION_DISABLED', 'Sign-up is turned off on this server');
    }
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
    if (token) await this.auth.logout(token, request.auth?.user);
    clearSessionCookie(response, this.secureCookie);
  }

  @AuthenticatedOnly()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke every session of the current user, on every device' })
  async logoutAll(
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (!request.auth) throw ApiError.unauthenticated();
    await this.auth.logoutAll(request.auth.user);
    clearSessionCookie(response, this.secureCookie);
  }

  @AuthenticatedOnly()
  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change your password (ends your other sessions)' })
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() request: AppRequest,
  ): Promise<void> {
    if (!request.auth) throw ApiError.unauthenticated();
    await this.limits.beforeChangePassword(request.auth.user.id);
    await this.auth.changePassword(request.auth.user, request.auth.sessionId, body);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ApiOperation({ summary: 'Email a password-reset link (answers the same for any address)' })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Req() request: AppRequest,
  ): Promise<{ accepted: true }> {
    await this.limits.beforeForgotPassword(request.ip, body.email);
    await this.auth.requestPasswordReset(body.email, request.ip ?? null);
    return { accepted: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password with a reset link' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.limits.beforeResetPassword(request.ip);
    await this.auth.resetPassword(body.token, body.password);
    // Every session was ended, this browser's included.
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
