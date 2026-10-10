import { AdminModule } from './admin.module';

/**
 * The staff-facing API, kept apart from the member-facing one.
 *
 * It is a sibling of `platform` rather than a folder inside it so the boundary is visible in the
 * tree and the dependency has one direction: admin may reach into member features through their
 * public surfaces, and nothing member-facing may reach into admin. A lint rule enforces both
 * halves (`eslint.config.mjs`), and `main.admin.ts` boots this surface on its own — which is what
 * keeps the separation true rather than merely intended.
 */
export const ADMIN_MODULES = [AdminModule];

export { AdminModule };
