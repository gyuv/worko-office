import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/** Validates and transforms input; output type is the schema's parsed type (defaults/coercions applied). */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- input type is irrelevant: any JSON may arrive
  constructor(private schema: ZodType<T, ZodTypeDef, any>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new BadRequestException({ message: 'Validation failed', issues: r.error.issues });
    return r.data;
  }
}
