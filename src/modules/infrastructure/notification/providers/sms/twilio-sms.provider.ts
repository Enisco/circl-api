import { INotification, SendResponse } from '@/modules/infrastructure/notification/interfaces';
import { AbstractSmsProvider } from './sms-provider.abstract';

export class TwilioSmsProvider extends AbstractSmsProvider {
  send(notification: INotification): Promise<SendResponse> {
    console.info('Sending sms to', notification);
    throw new Error('Method not implemented.');
  }
  name = 'twilio';
}
