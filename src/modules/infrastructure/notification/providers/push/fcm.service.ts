import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class FcmService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FcmService.name);
  }

  onModuleInit() {
    if (admin.apps.length) return;

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
        clientEmail: this.config.get<string>('FIREBASE_CLIENT_EMAIL'),
        privateKey: this.config.get<string>('FIREBASE_PRIVATE_KEY')!.replace(/\\n/g, '\n'),
      }),
    });

    this.logger.info('Firebase Admin SDK initialised');
  }

  async sendPush(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<string | null> {
    try {
      const messageId = await admin.messaging().send({
        token,
        notification: { title, body },
        ...(data && { data }),
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        android: { notification: { sound: 'default' } },
      });

      this.logger.info(`FCM message sent: ${messageId}`);

      return messageId;
    } catch (err) {
      this.logger.error(`FCM send failed: ${(err as Error).message}`);

      return null;
    }
  }
}
