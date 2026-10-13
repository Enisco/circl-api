import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  AdminReasonCode,
  AnnouncementChannel,
  AnnouncementState,
  BriefState,
  BriefUrgency,
  DealProblemState,
  DealTrack,
  DeliveryStatus,
  DisputeOutcome,
  DisputeReason,
  DisputeState,
  DisputeSubjectType,
  ManagedRequestClosedReason,
  ManagedRequestState,
  ManagedRequestSubject,
  ThreadAccessLinkType,
  AppealState,
  EscalationState,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  ReportReason,
  ReportState,
  ReportTargetType,
  RiskCategory,
  RiskLevel,
  SupportThreadState,
  SupportThreadType,
  TaxonomyKind,
} from '@prisma/client';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminAuthenticated } from '../common/admin-principal';
import { TaxonomyService } from '@/modules/platform/shared';
import { auditActionList } from '../audit/audit-actions';
import { ESCALATION_CATEGORIES } from '../dtos/admin-escalation.dto';
import { ASSIGNEE_QUEUES, AdminAssigneeService } from '../services/admin-assignee.service';

class AssigneeQueryDto {
  @ApiPropertyOptional({ enum: ASSIGNEE_QUEUES, description: 'Which queue the work sits in.' })
  @IsIn(ASSIGNEE_QUEUES)
  for!: string;
}

/** Which rule a `POLICY_VIOLATION` was. Free codes rather than an enum: the list will grow. */
const POLICY_SUBTYPES = [
  'SPAM',
  'HARASSMENT',
  'HATE',
  'SCAM',
  'IMPERSONATION',
  'NUDITY_SEXUAL',
  'VIOLENCE_THREAT',
  'ILLEGAL_ITEM',
  'MISINFORMATION',
  'OFF_PLATFORM_PAYMENT',
  'OTHER',
] as const;

/** `SCREAMING_SNAKE` into something a person reads: `OFF_PLATFORM_PAYMENT` → "Off platform payment". */
const labelOf = (code: string): string =>
  code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, first => first.toUpperCase());

const codes = (values: readonly string[]) => values.map(code => ({ code, label: labelOf(code) }));

/**
 * The vocabularies the portal renders.
 *
 * Served rather than compiled into the portal so a code added here appears in its dropdowns
 * without a release — and, more to the point, so the portal can never offer a code this API would
 * reject.
 */
@ApiExcludeController()
@ApiTags('Admin · Meta')
@Controller('admin/meta')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminMetaController {
  constructor(
    private readonly assignees: AdminAssigneeService,
    // For `guardCategories`, which comes from the vocabulary rather than a constant.
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** The safeguarding categories, active ones only: a retired one is not something to pick. */
  private async guardCategories() {
    const terms = await this.taxonomy.list(TaxonomyKind.GUARD_CATEGORY, true);

    return terms.map(term => ({ code: term.code, label: term.label }));
  }

  @Get('reason-codes')
  @AdminAuthenticated()
  @ApiOperation({ summary: 'Reason codes, and the policy subtypes behind POLICY_VIOLATION' })
  reasonCodes() {
    return {
      data: {
        reasonCodes: codes(Object.values(AdminReasonCode)),
        policySubtypes: codes(POLICY_SUBTYPES),
      },
      message: SuccessMessage.RESOURCE_FETCHED('Reason codes'),
    };
  }

  @Get('enums')
  @AdminAuthenticated()
  @ApiOperation({
    summary: 'Every enum the portal draws',
    description: 'With labels, so the portal holds no copy of this vocabulary to drift from.',
  })
  async enums() {
    return {
      data: {
        queueTypes: codes(Object.values(ModerationQueueType)),
        queueStates: codes(Object.values(ModerationQueueState)),
        decisions: codes(Object.values(ModerationDecision)),
        reportReasons: codes(Object.values(ReportReason)),
        reportStates: codes(Object.values(ReportState)),
        reportTargetTypes: codes(Object.values(ReportTargetType)),
        riskCategories: codes(Object.values(RiskCategory)),
        riskLevels: codes(Object.values(RiskLevel)),
        appealStates: codes(Object.values(AppealState)),
        escalationStates: codes(Object.values(EscalationState)),
        // Not a Prisma enum — `Escalation.category` is a string, because it is a routing hint
        // Support picks from a list rather than a state anything branches on, and a sixth
        // category should not be a migration. Published here all the same, so the portal still
        // holds no copy of the vocabulary.
        escalationCategories: codes([...ESCALATION_CATEGORIES]),
        // §5.15's two. Here rather than in `filter-options`, which publishes the **analytics**
        // filter vocabulary — a key there is a parameter the analytics endpoint accepts, and an
        // inbox filter is not one. Its own e2e asserts that, and caught the mistake.
        supportThreadTypes: codes(Object.values(SupportThreadType)),
        supportThreadStates: codes(Object.values(SupportThreadState)),
        // The safeguarding categories, from the taxonomy rather than a constant: the portal held
        // the seven codes as a fixed list because nothing served them, so rewording one here would
        // have left the escalation sheet offering the old label and an eighth would never have
        // appeared. Beside `escalationCategories`, which is the same kind of picker.
        guardCategories: await this.guardCategories(),
        // §5.6's. The grant dialog is built from `linkedType`, and a portal holding its own copy of
        // this list is a portal that offers a seventh kind the API refuses.
        threadAccessLinkTypes: codes(Object.values(ThreadAccessLinkType)),
        // §5.16's five. `managedClosedReasons` is the one that matters most: it is a required
        // field on a form, and the five values are what the pipeline is reported on.
        managedRequestStates: codes(Object.values(ManagedRequestState)),
        managedRequestSubjects: codes(Object.values(ManagedRequestSubject)),
        managedClosedReasons: codes(Object.values(ManagedRequestClosedReason)),
        briefStates: codes(Object.values(BriefState)),
        briefUrgencies: codes(Object.values(BriefUrgency)),
        // §5.17's five.
        disputeStates: codes(Object.values(DisputeState)),
        disputeReasons: codes(Object.values(DisputeReason)),
        disputeSubjectTypes: codes(Object.values(DisputeSubjectType)),
        disputeOutcomes: codes(Object.values(DisputeOutcome)),
        dealProblemStates: codes(Object.values(DealProblemState)),
        dealTracks: codes(Object.values(DealTrack)),
        // §5.18's three. `announcementChannels` is the one that matters on a form: the body limit
        // depends on whether PUSH is among them, so the portal has to know the vocabulary to warn
        // before the API refuses.
        announcementStates: codes(Object.values(AnnouncementState)),
        announcementChannels: codes(Object.values(AnnouncementChannel)),
        deliveryStatuses: codes(Object.values(DeliveryStatus)),
        auditAreas: codes([...new Set(auditActionList().map(entry => entry.area))]),
      },
      message: SuccessMessage.RESOURCE_FETCHED('Enums'),
    };
  }

  /**
   * Who a queue's work can be given to (§5.27).
   *
   * Opens on the **read** permissions so Trust & Safety and Support can fill an assignee dropdown
   * without `team:read` — the alternative was handing every moderator the staff directory, with
   * its names, roles, sessions and invite state, to populate one select.
   */
  @Get('assignees')
  // `disputes:manage` and `managed:manage` joined the list when §5.16 and §5.17 landed: both
  // pipelines assign work, and a lead who holds one of them without `support:read` could not
  // populate the dropdown for a queue they are the ones clearing.
  @AdminAnyPermission(
    'moderation:read',
    'guard:read',
    'support:read',
    'managed:manage',
    'disputes:manage',
  )
  @ApiOperation({
    summary: 'The staff a piece of work can be assigned to',
    description:
      'Keyed on who can **act** on the queue, not who can see it: assigning a thread to somebody ' +
      'who can only read it puts it in a queue they cannot clear and stops it reading as ' +
      'unassigned to everybody else. Deactivated accounts are left out for the same reason.',
  })
  async assigneesFor(@Query() query: AssigneeQueryDto) {
    const data = await this.assignees.forQueue(query.for);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Assignees') };
  }

  @Get('audit-actions')
  @AdminAuthenticated()
  @ApiOperation({
    summary: 'Every action the audit trail can record',
    description:
      'From the registry the audit writer itself uses, so the filter can only offer actions that ' +
      'exist.',
  })
  auditActions() {
    return {
      data: auditActionList().map(entry => ({
        action: entry.action,
        area: entry.area,
        label: labelOf(entry.action.replace(/\./g, ' ')),
      })),
      message: SuccessMessage.RESOURCE_FETCHED('Audit actions'),
    };
  }
}
