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
  // `uuid` ships ESM only, and importing anything through the `@/common` barrel pulls it in. Left
  // untransformed it fails at `export {`, which reads as a broken test rather than a config gap.
  // pnpm nests it at node_modules/.pnpm/uuid@13/node_modules/uuid, so the exception has to match
  // the path anywhere rather than the first segment.
  transformIgnorePatterns: ['node_modules/(?!.*uuid)'],
  // No setupFiles: unit tests mock all DB interactions and do not require a live database.
};

export default config;
