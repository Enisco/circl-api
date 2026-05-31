import { CORE_MODULES } from './core';
import { INFRASTRUCTURE_MODULES } from './infrastructure';
import { ADMIN_MODULES } from './admin';

export const MODULES = [...CORE_MODULES, ...ADMIN_MODULES, ...INFRASTRUCTURE_MODULES];
