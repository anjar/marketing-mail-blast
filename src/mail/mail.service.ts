import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface SendMessage {
  to: string;
  subject: string;
  body: string; // already personalized plain text
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  response: string;
}

/**
 * One long-lived pooled Nodemailer transport per process (Constitution VI, plan
 * SMTP section). Default target is the Mailpit compose service (never localhost
 * from inside the container). Closed during graceful shutdown.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const s = config.smtp;
    this.transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.user ? { user: s.user, pass: s.password } : undefined,
      pool: s.pool,
      maxConnections: s.maxConnections,
      maxMessages: s.maxMessages,
      connectionTimeout: s.connectionTimeout,
      greetingTimeout: s.greetingTimeout,
      socketTimeout: s.socketTimeout,
    } as nodemailer.TransportOptions);
  }

  /**
   * Send one dry-run message. Resolves with the SMTP acceptance info, or throws
   * a Nodemailer error carrying `code`/`responseCode` for the outcome classifier.
   */
  async send(message: SendMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: this.config.smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
    return {
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: info.response ?? '',
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing pooled SMTP transport');
    this.transport.close();
  }
}
