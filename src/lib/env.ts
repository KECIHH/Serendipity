import 'server-only';

import { parseEnv, requiredEnvKeys, type EnvSource } from '@/lib/env-schema';

export { EnvConfigError } from '@/lib/env-schema';

export const REQUIRED_ENV_KEYS = requiredEnvKeys('server');

/** Web configuration always comes from the active server registry. */
export function readEnv(source: EnvSource) {
  return parseEnv(source, 'server');
}

export const env = readEnv(process.env);
