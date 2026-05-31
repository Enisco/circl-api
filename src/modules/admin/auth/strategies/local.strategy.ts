import { BadRequestException, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { LoginService } from '../services/login.service';
import { ErrorMessage } from '@/common';

@Injectable()
export class AdminLocalStrategy extends PassportStrategy(Strategy, 'admin-local') {
  constructor(private readonly loginService: LoginService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string) {
    const user = await this.loginService.validateUser(email.trim().toLowerCase(), password);

    if (!user) {
      throw new BadRequestException(ErrorMessage.INVALID_CREDENTIALS);
    }

    return user;
  }
}
