import { AuditArea } from '@prisma/client';
import { MESSAGE_ESCALATED_ACTION } from '@/modules/platform/shared';
import { areaOf, auditActionList } from '../audit-actions';

/**
 * The one audit action the **platform** writes for itself.
 *
 * §6.8's message scan runs wherever the worker is, which may be a process with no admin code in
 * it, so it writes the row through Prisma with the action as a plain string. That string therefore
 * lives in the platform and its area lives here — two places, one fact, which is exactly the shape
 * that drifts. This test is the join: rename either side and it fails.
 */
describe('the action the platform writes', () => {
  it('is registered, so the trail can be read and filtered by area', () => {
    // The list is `{ action, area }` rows, which is what `GET admin/meta/enums` publishes.
    expect(auditActionList().map(entry => entry.action)).toContain(MESSAGE_ESCALATED_ACTION);
  });

  it('is filed under safety, which is who reads it', () => {
    expect(areaOf(MESSAGE_ESCALATED_ACTION as never)).toBe(AuditArea.SAFETY);
  });
});
