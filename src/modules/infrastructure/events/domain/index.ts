import { AuthEvents } from './auth/auth.domain.events';
import { UserEvents } from './user/user.event';

export const DomainEvents = [...Object.values(AuthEvents), ...Object.values(UserEvents)];

export * from './auth';
export * from './user';
