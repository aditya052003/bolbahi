import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getGnaniApiKey, gnaniIsConfigured } from '../server/gnani-key.js';
import { createApp } from '../server/index.js';

test('backend reads GNANI_API_KEY from its environment and treats blank values as missing', async () => {
  const configuredEnvironment = { GNANI_API_KEY: 'test-only-key' };
  assert.equal(gnaniIsConfigured(configuredEnvironment), true);
  assert.equal(await getGnaniApiKey(configuredEnvironment), 'test-only-key');

  const blankEnvironment = { GNANI_API_KEY: '   ' };
  assert.equal(gnaniIsConfigured(blankEnvironment), false);
  assert.equal(await getGnaniApiKey(blankEnvironment), null);
});

test('speech endpoint returns a clear backend configuration error when the key is missing', async () => {
  const app = createApp({
    apiKeyProvider: async () => null,
    speechConfigured: () => false,
  });
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transcribe`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Gnani configuration error: GNANI_API_KEY is missing from the backend environment.',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
