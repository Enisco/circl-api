#!/usr/bin/env node
/**
 * Reads an e2e sweep log and reports it honestly.
 *
 * Summing the `N passed, M failed` lines is not enough, and that is the whole reason this file
 * exists: a suite that **crashes** never prints one of those lines, so its checks are missing from
 * both totals and the sweep reads as clean. Three suites were crashing on a required column for
 * two stages before anybody noticed, while the tally said "0 failed" every time.
 *
 * So the first thing reported is whether every suite that started also finished.
 *
 * Usage: node scripts/sweep-report.mjs <log>
 */
import { readFileSync } from 'node:fs';

const log = readFileSync(process.argv[2], 'utf8');
const blocks = log.split(/═══ running (\S+)\n/).slice(1);

const suites = [];

for (let i = 0; i < blocks.length; i += 2) {
  const name = blocks[i];
  const body = blocks[i + 1] ?? '';
  const summary = /═══ (\d+) passed, (\d+) failed ═══/.exec(body);

  suites.push({
    name,
    passed: summary ? Number(summary[1]) : 0,
    failed: summary ? Number(summary[2]) : 0,
    finished: !!summary,
    reason: summary
      ? null
      : (/(\w*Error)[:\s]/.exec(body)?.[1] ?? (body.trim() ? 'no summary' : 'no output')),
  });
}

const unfinished = suites.filter(suite => !suite.finished);
const failing = suites.filter(suite => suite.failed > 0);
const passed = suites.reduce((total, suite) => total + suite.passed, 0);
const failed = suites.reduce((total, suite) => total + suite.failed, 0);

console.log(`suites started : ${suites.length}`);
console.log(`suites finished: ${suites.length - unfinished.length}`);
console.log(`checks passed  : ${passed}`);
console.log(`checks failed  : ${failed}`);

if (unfinished.length) {
  console.log(`\n✗ ${unfinished.length} suite(s) did NOT finish — their checks are in no total:`);
  for (const suite of unfinished) console.log(`    ${suite.name}  (${suite.reason})`);
}

if (failing.length) {
  console.log(`\n✗ ${failing.length} suite(s) with failing checks:`);
  for (const suite of failing) console.log(`    ${suite.name}  (${suite.failed})`);
}

if (!unfinished.length && !failing.length) console.log('\n✓ every suite finished, nothing failed');

process.exit(unfinished.length || failing.length ? 1 : 0);
