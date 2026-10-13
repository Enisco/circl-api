export * from './moderation.module';
export * from './moderation-core.module';
export * from './services/moderation.service';
export * from './services/report-case.service';
// §7.1's priority rules. On the barrel because §5.10's escalations assert, in a test, that the
// category they file under still comes out URGENT through this table — the indirection is correct
// and is exactly the kind that goes quietly wrong when somebody edits the other side.
export * from './services/report-priority';
