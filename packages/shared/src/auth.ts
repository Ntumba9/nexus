import { z } from 'zod';
import { roleSchema } from './permissions';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Small deny-list of extremely common passwords (checked case-insensitively). */
const COMMON_PASSWORDS = new Set(
  [
    'password1234',
    'password12345',
    'passwordpassword',
    '123456789012',
    '1234567890123',
    'qwertyuiop12',
    'qwertyuiopas',
    'iloveyou1234',
    'letmein12345',
    'welcome12345',
    'administrator',
    'changeme1234',
    'abcdefghijkl',
    'aaaaaaaaaaaa',
    '111111111111',
    'trustno1trustno1',
  ].map((password) => password.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter a valid email address')
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((password) => !isCommonPassword(password), 'That password is too common');

const nameSchema = z.string().trim().min(1, 'Name is required').max(100, 'Name is too long');

export const registerSchema = z
  .object({ email: emailSchema, password: passwordSchema, name: nameSchema })
  .refine((value) => value.password.toLowerCase() !== value.email, {
    path: ['password'],
    message: 'Password must not be your email address',
  });
export type RegisterInput = z.infer<typeof registerSchema>;

/** Login intentionally does not apply the password policy: it only needs *a* string. */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Changing your own password: proves you know the current one, and must actually change it. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password you have not used just now',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** A reset token is 32 random bytes, base64url without padding. */
export const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const RESET_TOKEN_TTL_MINUTES = 60;

export const resetPasswordSchema = z.object({
  token: z.string().regex(RESET_TOKEN_PATTERN, 'This reset link is not valid'),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const createOrganizationSchema = z.object({ name: nameSchema });
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({ name: nameSchema });
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const addMemberSchema = z.object({ email: emailSchema, role: roleSchema });
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberRoleSchema = z.object({ role: roleSchema });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

// ---- Response contracts -------------------------------------------------------------------

export interface UserDto {
  id: string;
  email: string;
  name: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MembershipDto {
  organizationId: string;
  name: string;
  slug: string;
  role: z.infer<typeof roleSchema>;
}

export interface MeResponse {
  user: UserDto;
  memberships: MembershipDto[];
}

export interface OrganizationDetailDto extends OrganizationDto {
  /** The caller's role in this organisation. */
  role: z.infer<typeof roleSchema>;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: z.infer<typeof roleSchema>;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId?: string;
  };
}
