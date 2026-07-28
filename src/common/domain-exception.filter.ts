import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { CampaignActiveError, CampaignNotFoundError } from './errors';

/**
 * Maps domain errors to deterministic HTTP responses (Constitution VIII:
 * actionable error categories). Body shape matches contracts/openapi.yaml Error.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof CampaignActiveError) {
      res.status(409).json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof CampaignNotFoundError) {
      res.status(404).json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      res.status(status).json({
        error: this.codeForStatus(status),
        message: Array.isArray(message) ? message.join('; ') : message,
      });
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case 400:
        return 'VALIDATION_ERROR';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      default:
        return 'ERROR';
    }
  }
}
