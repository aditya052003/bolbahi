import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';

// Esbuild's ESM bundle uses a dynamic-require shim for CommonJS dependencies.
// Initialize it before importing the Express app and its CommonJS dependencies.
globalThis.require ??= createRequire(import.meta.url);
const { createApp } = await import('./index.js');
const { createDynamoOrderRepository } = await import('./order-repository.js');

const DEFAULT_MAX_BINARY_RESPONSE_BYTES = 4 * 1024 * 1024;

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify({ error: message }),
    isBase64Encoded: false,
  };
}

function eventBody(event) {
  if (typeof event.body !== 'string' || event.body.length === 0) return undefined;
  return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
}

function requestHeaders(headers = {}, body) {
  const excluded = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (excluded.has(name.toLowerCase()) || value == null) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  if (body) result['content-length'] = String(body.length);
  return result;
}

function responseHeaders(headers = {}) {
  const excluded = new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length', 'date']);
  return Object.fromEntries(Object.entries(headers)
    .filter(([name, value]) => !excluded.has(name.toLowerCase()) && value != null)
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]));
}

export function createLambdaHandler({
  app,
  repository,
  apiKeyProvider,
  speechConfigured,
  fetchImpl,
  maxAudioBytes,
  upstreamTimeoutMs,
  maxBinaryResponseBytes = DEFAULT_MAX_BINARY_RESPONSE_BYTES,
} = {}) {
  const orderRepository = repository ?? createDynamoOrderRepository({ tableName: process.env.ORDERS_TABLE_NAME });
  const expressApp = app ?? createApp({ orderRepository, apiKeyProvider, speechConfigured, fetchImpl, maxAudioBytes, upstreamTimeoutMs, maxBinaryResponseBytes });
  const server = createServer(expressApp);
  let portPromise;

  function getPort() {
    if (!portPromise) {
      portPromise = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    }
    return portPromise;
  }

  async function lambdaHandler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    const port = await getPort();
    const body = eventBody(event);
    const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
    const path = event.rawPath ?? event.path ?? '/';
    const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const pathWithQuery = `${path}${query}`;

    return new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method,
        path: pathWithQuery,
        headers: requestHeaders(event.headers, body),
      }, (response) => {
        const chunks = [];
        let responseBytes = 0;
        response.on('data', (chunk) => {
          responseBytes += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const headers = responseHeaders(response.headers);
          const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
          const isBinary = contentType.startsWith('audio/') || contentType.startsWith('image/') || contentType.startsWith('application/octet-stream');
          if (isBinary && responseBytes > maxBinaryResponseBytes) {
            resolve(errorResponse(502, 'Gnani returned audio that is too large for this API. No order was saved.'));
            return;
          }
          resolve({
            statusCode: response.statusCode ?? 502,
            headers,
            body: isBinary ? responseBody.toString('base64') : responseBody.toString('utf8'),
            isBase64Encoded: isBinary,
          });
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  lambdaHandler.close = () => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
  return lambdaHandler;
}

let cachedHandler;

export async function handler(event, context) {
  if (!cachedHandler) cachedHandler = createLambdaHandler();
  return cachedHandler(event, context);
}
