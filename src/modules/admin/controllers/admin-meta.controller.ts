import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminReasonCode,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  ReportReason,
  ReportState,
  ReportTargetType,
  RiskCategory,
  RiskLevel,
} from '@prisma/client';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated } from '../common/admin-principal';
import { auditActionList } from '../audit/audit-actions';

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

const codes = (values: readonly string[]) =>
  values.map(code => ({ code, label: labelOf(code) }));

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
  enums() {
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
        // Appeals arrive with the safety milestone; the enum does not exist yet.
        auditAreas: codes([...new Set(auditActionList().map(entry => entry.area))]),
      },
      message: SuccessMessage.RESOURCE_FETCHED('Enums'),
    };
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
