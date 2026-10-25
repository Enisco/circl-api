import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { WebsiteFormController } from './controllers/website-form.controller';
import { WebsiteMailService } from './services/website-mail.service';
import { WebsiteSubmissionService } from './services/website-submission.service';

/**
 * The public website's forms.
 *
 * On the member surface, not the admin one. The website is served to anybody with a browser, so
 * its forms belong on the host that already answers the open internet — and a staff host answering
 * `POST /website/contact-messages` would be a public endpoint in a place nobody is looking for one,
 * which is the rule `AppPolicyModule` and the surface test exist to hold.
 *
 * No `*CoreModule` twin, because nothing else calls into this. When the portal grows a queue for
 * these submissions it reads the table directly, as the other admin lists do.
 */
@Module({
  imports: [
    NotificationModule,
    RouterModule.register([
      { path: 'api/v1', module: WebsiteModule, children: [WebsiteFormController] },
    ]),
  ],
  controllers: [WebsiteFormController],
  providers: [WebsiteSubmissionService, WebsiteMailService],
})
export class WebsiteModule {}
