import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDynamoOrderRepository } from '../server/order-repository.js';
import { createLambdaHandler } from '../server/lambda.js';

function encode(value) {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(encode) };
  return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) };
}

function decode(value) {
  if ('S' in value) return value.S;
  if ('N' in value) return Number(value.N);
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('L' in value) return value.L.map(decode);
  return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, decode(item)]));
}

function encodeItem(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
}

function decodeItem(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

function minimalWav() {
  const dataBytes = 3200; // 0.1 seconds of mono 16 kHz, 16-bit PCM
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function apiEvent({ method, path, headers = {}, body, encoded = false }) {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers,
    body,
    isBase64Encoded: encoded,
    requestContext: { http: { method } },
  };
}

function memoryOrderRepository() {
  return {
    async list() { return []; },
    async getByConfirmationToken() { return null; },
    async saveIfAbsent(order) { return { order, duplicate: false }; },
  };
}

test('DynamoDB repository uses conditional writes and the ordered history index', async () => {
  const calls = [];
  let saved;
  const client = {
    async send(command) {
      calls.push(command);
      if (command.name === 'PutItem') {
        if (saved) {
          const error = new Error('conditional write already exists');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
        saved = command.input.Item;
        return {};
      }
      if (command.name === 'GetItem') return { Item: saved };
      if (command.name === 'Query') {
        if (!saved) return { Items: [] };
        const latest = decodeItem(saved);
        const newer = { ...latest, createdAt: '2026-11-14T11:00:00.000Z', receiptNumber: 'BB-20261114-NEW001' };
        const older = { ...latest, createdAt: '2026-11-14T09:00:00.000Z', receiptNumber: 'BB-20261114-OLD001' };
        return { Items: [encodeItem({ ...newer, historyPartition: 'ORDERS', historySort: newer.createdAt + '#' + newer.receiptNumber }), encodeItem({ ...older, historyPartition: 'ORDERS', historySort: older.createdAt + '#' + older.receiptNumber })] };
      }
      throw new Error('Unexpected DynamoDB command: ' + command.name);
    },
  };
  const repository = createDynamoOrderRepository({
    tableName: 'orders-test',
    client,
    commandFactory: (name, input) => ({ name, input }),
  });
  const order = {
    id: 'order-id',
    receiptNumber: 'BB-20261114-ABC123',
    createdAt: '2026-11-14T10:00:00.000Z',
    customer: 'Walk-in #104',
    items: [{ productId: 'rice', quantityMilli: 1000, unit: 'kg', lineTotalPaise: 4200 }],
    totalPaise: 4200,
    confirmationToken: 'readback-token',
  };

  const created = await repository.saveIfAbsent(order);
  assert.equal(created.duplicate, false);
  assert.equal(calls[0].input.ConditionExpression, 'attribute_not_exists(confirmationToken)');
  assert.deepEqual(decodeItem(saved), {
    ...order,
    historyPartition: 'ORDERS',
    historySort: '2026-11-14T10:00:00.000Z#BB-20261114-ABC123',
  });

  const duplicate = await repository.saveIfAbsent(order);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.order.id, 'order-id');
  assert.equal(calls[2].name, 'GetItem');

  const history = await repository.list();
  assert.deepEqual(history.map((item) => item.createdAt), ['2026-11-14T09:00:00.000Z', '2026-11-14T11:00:00.000Z']);
  assert.equal(history[0].totalPaise, 4200);
  const query = calls.find((call) => call.name === 'Query');
  assert.equal(query.input.IndexName, 'orders-by-created');
  assert.equal(query.input.ScanIndexForward, false);
});

test('Lambda bridge accepts base64 multipart audio and returns the STT response as JSON', async (t) => {
  const audio = minimalWav();
  const boundary = 'bolbahi-audio-boundary';
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="audio_file"; filename="order.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
    audio,
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const lambda = createLambdaHandler({
    repository: memoryOrderRepository(),
    apiKeyProvider: async () => 'non-secret-test-value',
    speechConfigured: () => true,
    maxAudioBytes: 1024 * 1024,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.vachana.ai/stt/v3');
      assert.equal(request.headers['X-API-Key-ID'], 'non-secret-test-value');
      return {
        ok: true,
        async json() {
          return { success: true, transcript: 'दो किलो चावल', model: 'prisma-v3.0' };
        },
      };
    },
  });
  t.after(() => lambda.close());

  const response = await lambda(apiEvent({
    method: 'POST',
    path: '/api/transcribe',
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
    body: body.toString('base64'),
    encoded: true,
  }), {});

  assert.equal(response.statusCode, 200);
  assert.equal(response.isBase64Encoded, false);
  assert.deepEqual(JSON.parse(response.body), {
    transcript: 'दो किलो चावल',
    detectedLanguage: null,
    model: 'prisma-v3.0',
    durationSeconds: 0.1,
  });
});

test('Lambda bridge returns TTS WAV bytes as a base64 binary proxy response', async (t) => {
  const wav = minimalWav();
  const lambda = createLambdaHandler({
    repository: memoryOrderRepository(),
    apiKeyProvider: async () => 'non-secret-test-value',
    speechConfigured: () => true,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.vachana.ai/api/v1/tts/inference');
      assert.equal(JSON.parse(request.body).model, 'timbre-v2.5');
      return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
    },
  });
  t.after(() => lambda.close());

  const response = await lambda(apiEvent({
    method: 'POST',
    path: '/api/tts/readback',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: 'rice', quantityMilli: 1000, unit: 'kg' }] }),
  }), {});

  assert.equal(response.statusCode, 200);
  assert.equal(response.isBase64Encoded, true);
  assert.equal(response.headers['content-type'], 'audio/wav');
  assert.ok(response.headers['x-readback-token']);
  assert.deepEqual(Buffer.from(response.body, 'base64'), wav);
});

test('oversized TTS output is rejected before issuing a read-back token', async (t) => {
  let savedOrders = 0;
  const repository = memoryOrderRepository();
  repository.saveIfAbsent = async (order) => {
    savedOrders += 1;
    return { order, duplicate: false };
  };
  const lambda = createLambdaHandler({
    repository,
    apiKeyProvider: async () => 'non-secret-test-value',
    speechConfigured: () => true,
    maxBinaryResponseBytes: 32,
    fetchImpl: async () => new Response(Buffer.alloc(256), { headers: { 'content-type': 'audio/wav' } }),
  });
  t.after(() => lambda.close());

  const response = await lambda(apiEvent({
    method: 'POST',
    path: '/api/tts/readback',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: 'rice', quantityMilli: 1000, unit: 'kg' }] }),
  }), {});

  assert.equal(response.statusCode, 502);
  assert.match(JSON.parse(response.body).error, /too large/i);
  assert.equal(response.headers['x-readback-token'], undefined);
  assert.equal(savedOrders, 0);
});

test('SAM template keeps audio, CORS, environment, and DynamoDB access bounded', async () => {
  const template = await readFile(new URL('../template.yaml', import.meta.url), 'utf8');
  const backendManifest = await readFile(new URL('../server/package.json', import.meta.url), 'utf8');
  const backendLock = await readFile(new URL('../server/package-lock.json', import.meta.url), 'utf8');
  const lambdaSource = await readFile(new URL('../server/lambda.js', import.meta.url), 'utf8');
  assert.match(template, /MAX_AUDIO_BYTES: '4194304'/);
  assert.match(template, /MAX_BINARY_RESPONSE_BYTES: '4194304'/);
  assert.match(template, /UPSTREAM_TIMEOUT_MS: '24000'/);
  assert.match(template, /Timeout: 28/);
  assert.match(template, /PayloadFormatVersion: '2\.0'/);
  assert.match(template, /TimeoutInMillis: 29000/);
  assert.match(template, /AWS::URLSuffix/);
  assert.match(template, /ExposeHeaders:[\s\S]*x-readback-token/);
  assert.match(template, /CodeUri: server/);
  assert.match(template, /Handler: lambda\.handler/);
  assert.match(template, /Format: esm[\s\S]*OutExtension:[\s\S]*- \.js=\.mjs/);
  assert.doesNotMatch(template, /^\s+- (?:dotenv|express|multer)$/m);
  assert.match(template, /External:[\s\S]*@aws-sdk\/client-dynamodb/);
  assert.ok(lambdaSource.indexOf('globalThis.require ??=') < lambdaSource.indexOf("await import('./index.js')"));
  assert.doesNotMatch(template, /GnaniApiKeySecretArn|GNANI_API_KEY_SECRET_ARN|secretsmanager:/i);
  assert.doesNotMatch(template, /GNANI_API_KEY\s*:/);
  assert.doesNotMatch(backendManifest, /secretsmanager/i);
  assert.doesNotMatch(backendLock, /@aws-sdk\/client-secrets-manager/i);
  assert.match(template, /PointInTimeRecoveryEnabled: false/);
  assert.match(template, /dynamodb:GetItem/);
  assert.match(template, /dynamodb:PutItem/);
  assert.match(template, /dynamodb:Query/);
  assert.doesNotMatch(template, /dynamodb:\*/);
  assert.doesNotMatch(template, /secretsmanager:\*/);
});
