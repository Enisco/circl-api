import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  DecideListingReviewDto,
  ListListingReviewsDto,
  SetGatedProfessionsDto,
  SetVerificationGatesDto,
} from '../dtos/admin-listing-review.dto';
import { AdminListingReviewService } from '../services/admin-listing-review.service';

@ApiExcludeController()
@ApiTags('Admin · Professional reviews')
@Controller('admin/professional-reviews')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminListingReviewController {
  constructor(private readonly reviews: AdminListingReviewService) {}

  @Get()
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Listings waiting to be approved',
    description:
      'Professions where being wrong about who gave the advice has consequences — immigration, ' +
      'legal, finance, healthcare, therapy, childcare, lettings, trades, tutoring and ' +
      'recruitment — hold their listings until somebody reads them (§2.9). Which professions ' +
      'those are is taxonomy data (`PROFESSION.metadata.requiresReview`), editable from the ' +
      'configuration screens without a release.\n\n' +
      'Defaults to `PENDING`, oldest submission first: a member waiting to be allowed to work is ' +
      'waiting on us. `meta.liveWhileWaitingCount` is the urgent half — listings that were ' +
      'already live when approval started and were grandfathered rather than pulled down.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListListingReviewsDto) {
    query.assertDepth();

    const { data, meta } = await this.reviews.list(actor, query);

    return { data, meta, message: 'Reviews retrieved' };
  }

  // ─── Which professions are gated (§2.9) ────────────────────────────────────
  //
  // Declared **above** `@Get(':id')` on purpose. Nest matches in declaration order, and `:id`
  // carries a `ParseUUIDPipe` — below it, `GET …/categories` would be a 400 complaining that
  // "categories" is not a uuid. There is an e2e check pinning this, because the symptom of getting
  // it wrong is a 400 on a route that looks perfectly correct.

  @Get('categories')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every profession, and whether it holds its listings',
    description:
      'The list behind §2.9, with `requiresReview` on each — and `listings` / `pendingReviews` ' +
      'counts beside it, because "gate this profession" reads very differently when it says 340 ' +
      'listings are about to be queued.\n\n' +
      '`requiresReview` and `isRegulated` are **different questions** and must not be rendered as ' +
      'one control. `isRegulated` is a fact about the world — whether a regulator exists — and is ' +
      "read-only here. `requiresReview` is the operator's decision about whether a human reads " +
      'the listing before anybody can find it.',
  })
  async categories() {
    return { data: await this.reviews.categories(), message: 'Professions retrieved' };
  }

  @Put('categories')
  @AdminPermissions('professions:gate')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change which professions are gated',
    description:
      'Send the **whole set**, not a toggle: a toggle raced with another toggle leaves the list in ' +
      'a state neither person chose, and this write has consequences attached.\n\n' +
      'Those consequences are applied in the same transaction. Gating a profession does **nothing ' +
      'to the listings already in it**: approval applies to accounts created afterwards, so nobody ' +
      'trading today is pulled into a queue they never chose to enter on the strength of a ' +
      'settings change. Listings in a **newly ungated** profession are released, unless they are ' +
      'also in a profession that is still gated. Listings already approved or declined are left ' +
      'alone: re-gating is not a reason to re-decide what somebody already read.\n\n' +
      "The response's `applied` block says what happened — which professions changed, how many " +
      'listings were queued and how many released. A request that changes nothing writes no audit ' +
      'entry and returns an empty `applied`.\n\n' +
      'Held by Trust & Safety, managers and super admins (`professions:gate`). Support cannot.',
  })
  async setCategories(@CurrentUser() actor: AdminPrincipal, @Body() dto: SetGatedProfessionsDto) {
    const { data } = await this.reviews.setGated(actor, dto);

    return { data, message: 'Professions updated' };
  }

  // Also above `@Get(':id')`, for the same reason: a literal segment below a uuid pipe is a 400.

  @Get('verification-gates')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every profession subcategory, and whether selling under it needs verification',
    description:
      'The gate that matters since Professionals v2 (§3.2): a service needs an approved ' +
      '`(professional, category)` verification **iff** its subcategory requires one — or, where a ' +
      'service has no subcategory, its category does. No category requires one; 35 subcategories ' +
      'do.\n\n' +
      '`services` is how many live services are sold under it, and `servicesWithoutApproval` is ' +
      'how many of those belong to somebody with no approved verification for the category — ' +
      'which is exactly how many would stop being visible the moment the gate goes on. Render it ' +
      'in the confirmation, not in a tooltip.\n\n' +
      '`credentialBodies` is reference data for the reviewer: who registers this work. It says ' +
      'nothing about whether the gate is on.',
  })
  async verificationGates() {
    return { data: await this.reviews.verificationGates(), message: 'Subcategories retrieved' };
  }

  @Put('verification-gates')
  @AdminPermissions('professions:gate')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change which subcategories require verification',
    description:
      'Send the **whole set**, not a toggle — this write publishes and unpublishes live work, and ' +
      'a toggle raced with another toggle leaves the list in a state nobody chose.\n\n' +
      'Nothing walks the services: a service’s status is derived from this flag and the ' +
      "member's verification, so the write *is* the consequence. `applied.servicesBlocked` is how " +
      'many live services just went out of sight, `applied.servicesPublished` how many came back. ' +
      'A request that changes nothing writes no audit entry.\n\n' +
      'Held by `professions:gate` rather than `config:taxonomy`, deliberately: deciding that ' +
      '*Immigration solicitor* may not be sold unchecked is Trust & Safety’s judgement about ' +
      'regulated work, and they do not hold the permission that lets somebody reword every ' +
      'vocabulary on the platform. `metadata` is written **merged**, so a gate change cannot take ' +
      '`parentCode` or `credentialBodies` with it.',
  })
  async setVerificationGates(
    @CurrentUser() actor: AdminPrincipal,
    @Body() dto: SetVerificationGatesDto,
  ) {
    const { data } = await this.reviews.setVerificationGates(actor, dto);

    return { data, message: 'Subcategories updated' };
  }

  @Get(':id')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One listing, as the reviewer needs to see it',
    description:
      'The listing as the member wrote it, its services, which of its professions are gated and ' +
      'what bodies regulate them, the author with their strike count and account age, the safety ' +
      'verdict, and every past decision on this listing.\n\n' +
      'The consent block is the whole of what Circl holds about their right to do this work: D13 ' +
      'means no credential has been checked, and the payload says so rather than implying more.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.reviews.detail(id), message: 'Review retrieved' };
  }

  @Get(':id/documents/:documentId')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One supporting document',
    description:
      'The file bytes, with `Content-Type` exactly one of `application/pdf`, `image/png` or ' +
      '`image/jpeg`. **No redirect and no presigned URL**: a presigned URL is a bearer token for ' +
      'somebody’s qualification certificate — it works for anybody holding it, outlives the ' +
      'session that minted it, and lands in browser history and any proxy on the way. Every byte ' +
      'of this goes through the staff guard stack instead.\n\n' +
      'Sent as `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and ' +
      '`Cache-Control: no-store`, so nothing a member uploads renders in the portal and no copy ' +
      'is left in a cache. Check the first bytes match the type before displaying it.\n\n' +
      '`content:moderate`, so reviewers only — Support cannot open these.\n\n' +
      '404 when the document is not part of this listing’s **current** submission (a superseded ' +
      'one included: the reviewer is deciding a submission, and a file no longer in it is not part ' +
      'of what they are deciding). 409 `DOCUMENT_SCANNING` while it is still being checked, 410 ' +
      '`DOCUMENT_REMOVED` if it was removed or is no longer stored.\n\n' +
      'Audited as `listing.document_viewed`, once per staff member per document per fifteen ' +
      'minutes — enough to answer "who looked at my certificate" without burying it under how ' +
      'somebody’s PDF viewer re-requests pages.',
  })
  async document(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() response: ExpressResponse,
  ) {
    const file = await this.reviews.document(actor, id, documentId);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.bytes.length);
    // `attachment`, and the filename quoted and stripped of anything that could break the header:
    // the name came off a member's device and is text somebody else chose.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.send(file.bytes);
  }

  @Post(':id/claim')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take the review',
    description:
      'So two people do not approve the same listing twice. 409 `CLAIMED_BY_OTHER` with the ' +
      'assignee in `data`, or `INVALID_TRANSITION` if it has already been decided.',
  })
  async claim(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.reviews.claim(actor, id), message: 'Review claimed' };
  }

  @Post(':id/decide')
  @AdminPermissions('content:moderate')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or decline',
    description:
      '`APPROVED` publishes the listing — it becomes browsable, bookable and messageable, and the ' +
      'member is told. `REJECTED` leaves it unpublished, and `memberMessage` is **required**: ' +
      'everywhere else in the portal it is optional because the action speaks for itself, but ' +
      'here somebody is being told they may not do the work they signed up to do, and "not ' +
      'approved" alone gives them nothing to fix.\n\n' +
      'Either way the decision is recorded as a `ModerationAction`, which outlives the next edit ' +
      'of the listing. A member who edits their title or their about paragraph afterwards comes ' +
      'back through this queue: approval was of what the listing said.',
  })
  async decide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideListingReviewDto,
  ) {
    const { data } = await this.reviews.decide(actor, id, dto);

    return { data, message: 'Review decided' };
  }
}
