import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PinoLogger } from 'nestjs-pino';

/** FCM's own cap on one multicast call. */
const MULTICAST_LIMIT = 500;

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

  /**
   * True only when FCM says the token is permanently dead, so the caller can forget it. A network
   * blip or an FCM outage is not this and must not cost a member their push.
   */
  static isDeadToken(error: unknown): boolean {
    const code =
      (error as { errorInfo?: { code?: string }; code?: string })?.errorInfo?.code ??
      (error as { code?: string })?.code ??
      '';

    return (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    );
  }

  /**
   * Sends to every device a member is signed in on, reporting back the dead tokens.
   * `sendEachForMulticast` answers per token, aligned by index, so one dead device is named
   * precisely rather than failing the whole send.
   */
  async sendPushToMany(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ sent: number; deadTokens: string[] }> {
    if (!tokens.length) return { sent: 0, deadTokens: [] };

    const message = this.buildMessage(title, body, data);

    try {
      // FCM caps a multicast at 500. Nobody holds ten devices, let alone five hundred, but a cap
      // that is not enforced is a cap that fails in production rather than here.
      const batch = tokens.slice(0, MULTICAST_LIMIT);
      const result = await admin.messaging().sendEachForMulticast({ tokens: batch, ...message });
      const deadTokens = result.responses.flatMap((response, index) =>
        !response.success && FcmService.isDeadToken(response.error) ? [batch[index]] : [],
      );

      this.logger.info(
        `FCM multicast: ${result.successCount}/${batch.length} delivered` +
          (deadTokens.length ? `, ${deadTokens.length} dead token(s)` : ''),
      );

      return { sent: result.successCount, deadTokens };
    } catch (err) {
      // The whole call failed, which is a credential or a network problem and says nothing about
      // any individual token. Losing every device over it would be the wrong repair.
      this.logger.error(`FCM multicast failed: ${(err as Error).message}`);

      return { sent: 0, deadTokens: [] };
    }
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
        ...this.buildMessage(title, body, data),
      });

      this.logger.info(`FCM message sent: ${messageId}`);

      return messageId;
    } catch (err) {
      this.logger.error(`FCM send failed: ${(err as Error).message}`);

      // Rethrown only when the token itself is the problem, so the caller can forget it. Every
      // other failure stays swallowed: a push is not worth failing anything over.
      if (FcmService.isDeadToken(err)) throw err;

      return null;
    }
  }

  /** Everything but the address, so the single and multicast paths cannot drift apart. */
  private buildMessage(title: string, body: string, data?: Record<string, string>) {
    // FCM data payloads are string-to-string. A number or a nested object arrives as something
    // the client will not read, so everything is stringified here rather than at each caller.
    const payload = data
      ? Object.fromEntries(
          Object.entries(data)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
        )
      : undefined;
    const badge = Number(payload?.badge);
    // Omitted rather than guessed when there is no usable count, so iOS leaves the icon as it is.
    // A fallback of `1` looks exactly like a real count and is wrong for everyone.
    const hasBadge = payload?.badge !== undefined && Number.isFinite(badge);
    const collapseKey = payload?.collapseKey;

    return {
      notification: { title, body },
      ...(payload && { data: payload }),
      apns: {
        // Twenty messages in one thread are one notification on iOS too. Android uses
        // `collapseKey` below; APNs needs this header.
        ...(collapseKey ? { headers: { 'apns-collapse-id': collapseKey.slice(0, 64) } } : {}),
        payload: {
          aps: { sound: 'default', ...(hasBadge ? { badge } : {}) },
        },
      },
      android: {
        notification: { sound: 'default' },
        // Twenty messages in one thread are one notification, not twenty.
        ...(collapseKey ? { collapseKey } : {}),
      },
    };
  }
}
