import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';

/**
 * Transactional mail.
 *
 * Delivery is a pluggable interface for the same reason `STORAGE_DRIVER`
 * is: this platform bundles no paid service, and a mail relay is an
 * operator's own choice, not this codebase's. `ConsoleMailer` is the
 * default and always what runs in development and test — it logs the
 * message rather than sending it, so the password-reset flow is
 * exercisable end to end with nothing configured. `SmtpMailer` sends for
 * real through `nodemailer` (a free library with no paid API of its own)
 * once an operator points `SMTP_HOST` at a relay.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info(
      { to: message.to, subject: message.subject, text: message.text },
      'Mail (console transport — not actually sent; set MAIL_DRIVER=smtp to send for real)',
    );
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    private readonly from: string,
    config: { host: string; port: number; secure: boolean; user?: string; password?: string },
  ) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

export function createMailer(env: Env, log: FastifyBaseLogger): Mailer {
  if (env.MAIL_DRIVER === 'smtp') {
    // `loadEnv` already refuses to start with MAIL_DRIVER=smtp and no
    // SMTP_HOST, so this is never reached with it undefined.
    return new SmtpMailer(env.MAIL_FROM, {
      host: env.SMTP_HOST as string,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    });
  }
  return new ConsoleMailer(log);
}
