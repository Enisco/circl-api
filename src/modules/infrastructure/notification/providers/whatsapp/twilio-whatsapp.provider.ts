import { INotification, SendResponse } from '@/modules/infrastructure/notification/interfaces';
import { AbstractWhatsAppProvider } from './whatsapp-provider.abstract';
import { ConfigService } from '@nestjs/config';

export class TwilioWhatsappProvider extends AbstractWhatsAppProvider {
  name = 'twilio-whatsapp';

  constructor(private readonly configService: ConfigService) {
    super();
  }

  send(notification: INotification): Promise<SendResponse> {
    console.info('Sending whatsapp to', notification);
    throw new Error('Method not implemented.');
  }
}
