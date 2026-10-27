import { Injectable, Logger } from '@nestjs/common';

export interface SmsProvider { send(to: string, text: string, templateId?: string): Promise<void> }

/** Mock DLT SMS provider. Real adapters (DLT-registered) plug in via SMS_PROVIDER. Keeps last message for tests. */
@Injectable()
export class MockSmsProvider implements SmsProvider {
  private readonly log = new Logger('MockSms');
  readonly sent: Array<{ to: string; text: string }> = [];
  async send(to: string, text: string) {
    this.sent.push({ to, text });
    if (process.env.NODE_ENV !== 'test') this.log.log(`SMS to ${to.slice(0, -4).replace(/\d/g, '•')}${to.slice(-4)} (dev: ${text})`);
  }
}
export const SMS_PROVIDER = 'SMS_PROVIDER';
