import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public, RateLimit, SuccessMessage } from '@/common';
import { ContactMessageDto, DeletionRequestDto, FeatureSuggestionDto } from '../dtos';
import { WebsiteSubmissionService } from '../services/website-submission.service';

/**
 * The public website's three forms (`API-WEBSITE-FORMS.md`).
 *
 * `@Public()` on all of them, and that is the requirement rather than a convenience: the visitor
 * may have no account, or may have one they cannot get into — which is the entire reason the third
 * form exists. An endpoint behind authentication could not serve the person it is for.
 *
 * Only the status matters to the website, so each one returns the envelope every other route does
 * and nothing more. A `400` should never reach a visitor, because the website checks the same
 * rules first; one that does means the two sides have drifted, so the validation pipe's log is
 * where to look.
 */
@Controller('website')
@ApiTags('Website')
export class WebsiteFormController {
  constructor(private readonly submissions: WebsiteSubmissionService) {}

  @Post('contact-messages')
  @Public()
  @RateLimit('WEBSITE_FORM')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a message',
    description:
      'A question about Circl, an account, or working with us. Emailed to the team with the ' +
      "visitor's address as `Reply-To`, so answering is one keystroke.",
  })
  async contactMessage(@Body() dto: ContactMessageDto, @Req() request: Request) {
    const data = await this.submissions.contactMessage(dto, request.ip ?? null);

    return { data, message: 'Thanks, we got it.' };
  }

  @Post('feature-suggestions')
  @Public()
  @RateLimit('WEBSITE_FORM')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Suggest a feature',
    description: 'An idea for the app. The address is optional, for somebody who wants a reply.',
  })
  async featureSuggestion(@Body() dto: FeatureSuggestionDto, @Req() request: Request) {
    const data = await this.submissions.featureSuggestion(dto, request.ip ?? null);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Suggestion') };
  }

  /**
   * "Ask us to delete your account" — the page Google Play requires.
   *
   * **`202` and the same body every time**, whether or not that address has an account, and
   * whether or not this is the fourth attempt today. Whether somebody is on Circl is not something
   * a public form may answer: for this community, confirming that a particular person has an
   * account can put them at risk. The account lookup therefore happens after the response has
   * been sent, so the timing cannot answer what the body refuses to.
   *
   * It starts a process and deletes nothing. The app's own flow — `POST /users/me/deletion/request`
   * and `/confirm` — is untouched and remains the only path that deletes without a person at Circl
   * in the loop.
   */
  @Post('deletion-requests')
  @Public()
  @RateLimit('WEBSITE_FORM')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask us to delete your account',
    description:
      'Always `202`, with the same body, whether or not the address belongs to an account — a ' +
      'public form may not be a way to find out who is on Circl. Nothing is deleted until the ' +
      'person proves they can read the inbox on the account.',
  })
  async deletionRequest(@Body() dto: DeletionRequestDto, @Req() request: Request) {
    await this.submissions.deletionRequest(dto, request.ip ?? null);

    return { data: null, message: 'We’ve got your request.' };
  }
}
