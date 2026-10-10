import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  passWithNoTests: true,
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  // Four dependencies ship ESM only, and each is reachable from a barrel a test imports: `uuid`
  // through `@/common`, `@scure/base` and `@noble/hashes` through `otplib` in the admin module, and
  // `jose` through the social sign-in verifier.
  // Left untransformed they fail at `export {`, which reads as a broken test rather than a config
  // gap. pnpm nests them (node_modules/.pnpm/uuid@13/node_modules/uuid), so the exception has to
  // match the path anywhere rather than the first segment.
  transformIgnorePatterns: ['node_modules/(?!.*(uuid|@scure|@noble|otplib|jose))'],
  // No setupFiles: unit tests mock all DB interactions and do not require a live database.
};

export default config;
