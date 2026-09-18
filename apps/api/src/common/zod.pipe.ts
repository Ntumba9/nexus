import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from './api-error';

/** Validates and transforms a request part with a Zod schema; failures become a 400 envelope. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw ApiError.validation(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}

export const uuidSchema = z.uuid();

/** Route params that are not valid UUIDs are indistinguishable from unknown resources. */
export class UuidParamPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuidSchema.safeParse(value);
    if (!result.success) throw ApiError.notFound();
    return result.data;
  }
}
