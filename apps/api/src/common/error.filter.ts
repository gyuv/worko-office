import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Uniform error body `{ statusCode, message, code?, issues? }`; never leaks internals for 5xx. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Error');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const body = typeof r === 'string' ? { message: r } : (r as Record<string, unknown>);
      res.status(e.getStatus()).json({ statusCode: e.getStatus(), ...body });
      return;
    }
    this.log.error(e instanceof Error ? e.stack : String(e));
    res.status(500).json({ statusCode: 500, message: 'Something went wrong' });
  }
}
