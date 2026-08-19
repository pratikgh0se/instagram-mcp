import assert from 'node:assert/strict';
import test from 'node:test';

import { InstagramError, loadConfig } from '../src/config.js';

test('loads a normalized account allowlist from environment', () => {
  const config = loadConfig({
    INSTAGRAM_ACCOUNT_IDS: '1784,  1785 ,',
    INSTAGRAM_ACCESS_TOKEN: 'secret-token'
  });

  assert.deepEqual(config.accountIds, new Set(['1784', '1785']));
  assert.equal(config.apiBaseUrl, 'https://graph.instagram.com');
  assert.equal(config.apiVersion, 'v25.0');
});

test('rejects incomplete configuration without exposing a token', () => {
  assert.throws(
    () => loadConfig({ INSTAGRAM_ACCOUNT_IDS: '1784' }),
    (error: unknown) => error instanceof InstagramError && error.code === 'INVALID_INPUT'
  );
});
