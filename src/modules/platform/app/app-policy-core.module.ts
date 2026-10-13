import { Module } from '@nestjs/common';
import { AppPolicyService } from './app-policy.service';

/**
 * The version verdict, with no route.
 *
 * Two callers need it and neither is a controller: the **global** force-update interceptor on the
 * member surface, and §5.21's staff screen, which reads the policy back after writing it. A global
 * provider reaching into a product section's module is how a module graph becomes a cycle, so the
 * service has a module of its own that both can import.
 */
@Module({
  providers: [AppPolicyService],
  exports: [AppPolicyService],
})
export class AppPolicyCoreModule {}
