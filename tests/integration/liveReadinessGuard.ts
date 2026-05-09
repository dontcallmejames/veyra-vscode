import { beforeAll } from 'vitest';

// @ts-expect-error The verifier is a plain Node .mjs script used by npm preflight and direct live test guards.
import { assertLiveReadiness } from '../../scripts/verify-live-ready.mjs';

export function guardLiveModelPrompts() {
  beforeAll(() => {
    assertLiveReadiness();
  });
}
