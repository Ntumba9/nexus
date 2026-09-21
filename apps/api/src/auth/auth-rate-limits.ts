import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import { ENV } from '../infrastructure/tokens';
import { RATE_LIMITER } from '../rate-limit/tokens';
import type { RateLimiter } from '../rate-limit/rate-limiter';

/**
 * Rate-limit policy for credential endpoints. Two independent dimensions, so an attacker cannot
 * evade by rotating either one:
 *  - per account (email): stops password guessing against one user from many IPs;
 *  - per client IP: stops one machine from sweeping many accounts.
 * All attempts count, successful or not.
 */
@Injectable()
export class AuthRateLimits {
  private readonly perAccount: number;
  private readonly perIp: number;
  private readonly windowSeconds: number;

  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.perAccount = env.AUTH_RATE_LIMIT_MAX;
    this.perIp = env.AUTH_RATE_LIMIT_MAX * 3;
    this.windowSeconds = env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
  }

  async beforeLogin(ip: string | undefined, email: string): Promise<void> {
    await this.limiter.consume('login:ip', ip ?? 'unknown', this.perIp, this.windowSeconds);
    await this.limiter.consume('login:account', email, this.perAccount, this.windowSeconds);
  }

  /**
   * Asking for a reset email is limited per address (so nobody can flood one inbox) and per IP (so
   * one machine cannot sweep for accounts). It answers the same whether or not the account exists.
   */
  async beforeForgotPassword(ip: string | undefined, email: string): Promise<void> {
    await this.limiter.consume('forgot:ip', ip ?? 'unknown', this.perAccount, this.windowSeconds);
    await this.limiter.consume('forgot:account', email, 3, 3600);
  }

  /** Redeeming a token is guess-resistant by entropy already; this only stops hammering. */
  async beforeResetPassword(ip: string | undefined): Promise<void> {
    await this.limiter.consume('reset:ip', ip ?? 'unknown', this.perAccount, this.windowSeconds);
  }

  async beforeChangePassword(userId: string): Promise<void> {
    await this.limiter.consume('change-password:user', userId, this.perAccount, this.windowSeconds);
  }

  async beforeRegister(ip: string | undefined): Promise<void> {
    await this.limiter.consume('register:ip', ip ?? 'unknown', this.perAccount, this.windowSeconds);
  }
}
