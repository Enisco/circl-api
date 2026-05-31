import { Injectable } from '@nestjs/common';
import { DeviceInfo, SuccessMessage } from '@/common';
import { LogoutDto } from '../dtos';
import { SessionService } from './session.service';

@Injectable()
export class LogoutService {
  constructor(private readonly sessionService: SessionService) {}

  async logout(userId: string, deviceInfo: DeviceInfo, dto: LogoutDto) {
    const revokeAll = dto.revokeAll ?? false;
    const session = await this.sessionService.findSessionByFingerprint(
      userId,
      deviceInfo.deviceFingerprint,
    );

    if (session) {
      await this.sessionService.revoke(session.id, userId, revokeAll);
    }

    return {
      message: revokeAll
        ? 'Logged out from all devices successfully'
        : SuccessMessage.LOGOUT_SUCCESSFUL,
    };
  }
}
