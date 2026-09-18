import { describe, expect, it } from 'vitest';
import { loginSchema, passwordSchema, registerSchema } from './index';

describe('auth schemas', () => {
  it('normalises email to lower case and trims', () => {
    const parsed = registerSchema.parse({
      email: '  Ada@Example.COM ',
      password: 'correct horse battery',
      name: 'Ada',
    });
    expect(parsed.email).toBe('ada@example.com');
  });

  it('enforces password length bounds and the common-password list', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('Password12345').success).toBe(false);
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });

  it('rejects a password equal to the email', () => {
    const result = registerSchema.safeParse({
      email: 'someone@example.com',
      password: 'someone@example.com',
      name: 'S',
    });
    expect(result.success).toBe(false);
  });

  it('login does not apply the password policy', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });
});
