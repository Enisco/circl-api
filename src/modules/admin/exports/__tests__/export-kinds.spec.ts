import { AdminExportKind } from '@prisma/client';
import { EXPORT_KINDS, columnOf, contactColumns, orderColumns } from '../export-kinds';

const KINDS = Object.values(AdminExportKind);

describe('export kinds', () => {
  it('declares every kind the enum names, so none can be asked for without a rule', () => {
    expect(Object.keys(EXPORT_KINDS).sort()).toEqual([...KINDS].sort());
  });

  it.each(KINDS)('%s names the list permission it comes from', kind => {
    const permissions = EXPORT_KINDS[kind].listPermissions;

    expect(permissions.length).toBeGreaterThan(0);
    // `exports:csv` is on the route. A kind that repeated it here would be saying "anybody who
    // may export may export this", which is the check this table exists to add.
    expect(permissions).not.toContain('exports:csv');
    permissions.forEach(permission => expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/));
  });

  /**
   * The table has to stay honest in both directions: a kind marked available with no builder is an
   * export that fails after a staff member waits for it, and a kind marked unavailable that *is*
   * built is a screen refusing something that works.
   *
   * Written as the explicit list rather than a count, so adding a builder means editing this line
   * — which is the moment to check the runner's switch has a case for it.
   */
  it('is honest about which kinds are built', () => {
    const available = KINDS.filter(kind => EXPORT_KINDS[kind].available);

    expect(available).toEqual([
      AdminExportKind.MEMBERS,
      AdminExportKind.AUDIT,
      AdminExportKind.REPORTS,
      AdminExportKind.ENFORCEMENT,
      AdminExportKind.CONTENT,
      AdminExportKind.SUPPORT_THREADS,
    ]);
  });

  it.each(KINDS.filter(kind => !EXPORT_KINDS[kind].available))(
    '%s says why it cannot be exported, in a sentence',
    kind => {
      expect(EXPORT_KINDS[kind].pending ?? '').toMatch(/\S.*\./);
    },
  );

  it('offers the MEMBERS columns §13.18 lists, and no others', () => {
    expect(EXPORT_KINDS.MEMBERS.columns.map(column => column.key)).toEqual([
      'id',
      'name',
      'username',
      'status',
      'city',
      'journeyStage',
      'platform',
      'createdAt',
      'lastActiveAt',
      'email',
      'phone',
    ]);
  });

  /**
   * The one trap in the MEMBERS builder, held shut.
   *
   * `AdminMemberService.exportPage` serialises each row with the list's own serialiser but passes
   * both aggregates as zero, because counting live strikes and reports received for every row of a
   * sixty-thousand-row file would double the cost of the export and §13.18 asks for neither. If a
   * column for one of them is ever added to this allowlist, it has to come with a count — so this
   * fails here rather than exporting a column of zeroes.
   */
  it('offers no column whose number the export does not compute', () => {
    const aggregates = ['activeStrikes', 'reportsReceived', 'strikes', 'reports'];

    expect(EXPORT_KINDS.MEMBERS.columns.filter(column => aggregates.includes(column.key))).toEqual(
      [],
    );
  });

  it('marks exactly the two contact columns, which are what members:pii_reveal gates', () => {
    expect(EXPORT_KINDS.MEMBERS.columns.filter(column => column.contact).map(c => c.key)).toEqual([
      'email',
      'phone',
    ]);
  });

  /**
   * Every built kind offers columns, because a kind marked available with an empty allowlist
   * refuses every request: `orderColumns` drops what it cannot find, and the service refuses an
   * empty column set. ANALYTICS_CHART is the one exception and is unavailable for that reason.
   */
  it.each(KINDS.filter(kind => EXPORT_KINDS[kind].available))('%s offers columns', kind => {
    expect(EXPORT_KINDS[kind].columns.length).toBeGreaterThan(0);
    expect(new Set(EXPORT_KINDS[kind].columns.map(column => column.key)).size).toBe(
      EXPORT_KINDS[kind].columns.length,
    );
  });

  it('reserves ANALYTICS_CHART with no columns, because chart CSVs are built in the browser', () => {
    expect(EXPORT_KINDS.ANALYTICS_CHART.columns).toEqual([]);
    expect(EXPORT_KINDS.ANALYTICS_CHART.available).toBe(false);
  });
});

describe('the columns a request asks for', () => {
  it('comes back in the kind’s order, not the request’s, so two files line up', () => {
    expect(orderColumns(AdminExportKind.MEMBERS, ['phone', 'id', 'city'])).toEqual([
      'id',
      'city',
      'phone',
    ]);
  });

  it('de-duplicates, so asking twice does not write the column twice', () => {
    expect(orderColumns(AdminExportKind.MEMBERS, ['id', 'id'])).toEqual(['id']);
  });

  it('drops nothing silently: an unknown column is not in the result, which is what the service refuses on', () => {
    expect(columnOf(AdminExportKind.MEMBERS, 'passwordHash')).toBeUndefined();
    expect(orderColumns(AdminExportKind.MEMBERS, ['passwordHash'])).toEqual([]);
  });

  it('finds the contact columns among a mixed request', () => {
    expect(contactColumns(AdminExportKind.MEMBERS, ['id', 'email', 'city'])).toEqual(['email']);
    expect(contactColumns(AdminExportKind.MEMBERS, ['id', 'city'])).toEqual([]);
  });

  it('finds none for a kind that has none', () => {
    expect(contactColumns(AdminExportKind.CONTENT, ['targetId'])).toEqual([]);
  });
});
