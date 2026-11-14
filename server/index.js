import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createOrderService, OrderValidationError } from './order-service.js';
import { getGnaniApiKey, gnaniIsConfigured } from './gnani-key.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BINARY_RESPONSE_BYTES = 4 * 1024 * 1024;
const GNANI_STT_ENDPOINT = 'https://api.vachana.ai/stt/v3';
const GNANI_TTS_ENDPOINT = 'https://api.vachana.ai/api/v1/tts/inference';

async function readAudioWithinLimit(response, maximumBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
}

export function createApp({
  orderRepository,
  orderService,
  storagePath,
  apiKeyProvider = getGnaniApiKey,
  speechConfigured = gnaniIsConfigured,
  fetchImpl = fetch,
  maxAudioBytes: audioBytesOverride,
  upstreamTimeoutMs: timeoutOverride,
  maxBinaryResponseBytes: responseBytesOverride,
} = {}) {
  const app = express();
  const configuredMaxAudioBytes = Number(audioBytesOverride ?? process.env.MAX_AUDIO_BYTES ?? DEFAULT_MAX_AUDIO_BYTES);
  const maxAudioBytes = Number.isInteger(configuredMaxAudioBytes) && configuredMaxAudioBytes > 0
    ? configuredMaxAudioBytes
    : DEFAULT_MAX_AUDIO_BYTES;
  const upstreamTimeoutMs = Number(timeoutOverride ?? process.env.UPSTREAM_TIMEOUT_MS ?? 60_000);
  const configuredResponseLimit = Number(responseBytesOverride ?? process.env.MAX_BINARY_RESPONSE_BYTES ?? DEFAULT_MAX_BINARY_RESPONSE_BYTES);
  const maxBinaryResponseBytes = Number.isInteger(configuredResponseLimit) && configuredResponseLimit > 0
    ? configuredResponseLimit
    : DEFAULT_MAX_BINARY_RESPONSE_BYTES;
  const service = orderService ?? createOrderService({
    storagePath: storagePath ?? join(here, '..', 'data', 'orders.json'),
    repository: orderRepository,
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxAudioBytes, files: 1 } });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', async (_request, response) => {
    let configured = Boolean(speechConfigured());
    if (configured) {
      try {
        configured = Boolean(await apiKeyProvider());
      } catch {
        configured = false;
      }
    }
    response.json({ ok: true, speechConfigured: configured, maxAudioBytes });
  });

  async function requireGnaniKey(response) {
    try {
      const key = await apiKeyProvider();
      if (key) return key;
    } catch {
      // Do not return secret-store details or credential values to the client.
    }
    response.status(503).json({ error: speechConfigured()
      ? 'Gnani speech is temporarily unavailable. Please try again later.'
      : 'Gnani configuration error: GNANI_API_KEY is missing from the backend environment.' });
    return null;
  }

  app.post('/api/transcribe', upload.single('audio_file'), async (request, response) => {
    const apiKey = await requireGnaniKey(response);
    if (!apiKey) return;
    if (!request.file) return response.status(400).json({ error: 'No recording was received.' });
    let seconds;
    try {
      seconds = parseWavDuration(request.file.buffer);
    } catch (error) {
      return response.status(415).json({ error: error.message });
    }
    if (!request.file.mimetype.includes('wav')) return response.status(415).json({ error: 'Upload a converted WAV recording.' });

    try {
      const form = new FormData();
      form.append('audio_file', new Blob([request.file.buffer], { type: 'audio/wav' }), 'order.wav');
      form.append('model', 'prisma-v3.0');
      form.append('language_code', 'indic-auto');
      form.append('format', 'codemix');
      form.append('topic', 'A short Indian kirana grocery order with products, quantities, corrections, and removals.');
      form.append('keyterms', JSON.stringify(['चावल', 'chawal', 'rice', 'आटा', 'atta', 'चीनी', 'chini', 'तेल', 'tel', 'दूध', 'doodh', 'दाल', 'dal', 'नमक', 'namak', 'बिस्किट', 'biscuit']));
      const upstream = await fetchImpl(GNANI_STT_ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-Key-ID': apiKey },
        body: form,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
      if (!upstream.ok) return response.status(502).json({ error: 'Gnani could not transcribe this recording. Please try again.' });
      const result = await upstream.json();
      if (result.success !== true || typeof result.transcript !== 'string' || !result.transcript.trim()) {
        return response.status(422).json({ error: 'No clear speech was detected. Please record the order again.' });
      }
      return response.json({ transcript: result.transcript, detectedLanguage: result.detected_language_code ?? null, model: result.model ?? 'prisma-v3.0', durationSeconds: Math.round(seconds * 10) / 10 });
    } catch {
      return response.status(502).json({ error: 'Gnani speech service could not be reached. Please try again later.' });
    }
  });

  app.post('/api/tts/readback', async (request, response) => {
    const apiKey = await requireGnaniKey(response);
    if (!apiKey) return;
    let prepared;
    try {
      prepared = await service.prepareReadback(request.body?.items);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }

    try {
      const upstream = await fetchImpl(GNANI_TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-Key-ID': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: prepared.readbackText,
          model: 'timbre-v2.5',
          voice: 'Poorvi',
          language: 'hi-en',
          speed: 1.0,
          audio_config: { encoding: 'linear_pcm', container: 'wav', num_channels: 1, sample_rate: 48000, sample_width: 2 },
        }),
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
      if (!upstream.ok) return response.status(502).json({ error: 'Gnani could not read back this order. No order was saved.' });
      const contentType = upstream.headers.get('content-type') || '';
      const declaredLength = Number(upstream.headers.get('content-length') || 0);
      if (!contentType.toLowerCase().startsWith('audio/')) {
        return response.status(502).json({ error: 'Gnani returned an unsupported audio response. No order was saved.' });
      }
      if (declaredLength > maxBinaryResponseBytes) {
        return response.status(502).json({ error: 'Gnani returned audio that is too large for this API. No order was saved.' });
      }
      const audio = await readAudioWithinLimit(upstream, maxBinaryResponseBytes);
      if (!audio || audio.length === 0) {
        if (audio === null) return response.status(502).json({ error: 'Gnani returned audio that is too large for this API. No order was saved.' });
        return response.status(502).json({ error: 'Gnani returned an unsupported audio response. No order was saved.' });
      }
      const readbackToken = service.issueReadback(prepared.digest);
      response.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Readback-Token': readbackToken });
      return response.send(audio);
    } catch {
      return response.status(502).json({ error: 'Gnani speech service could not be reached. No order was saved.' });
    }
  });

  app.get('/api/orders', async (_request, response) => {
    try {
      response.json({ orders: await service.list() });
    } catch {
      response.status(500).json({ error: 'Saved order history could not be loaded.' });
    }
  });

  app.post('/api/orders', async (request, response) => {
    try {
      const result = await service.confirm({
        items: request.body?.items,
        confirmed: request.body?.confirmed,
        readbackToken: request.body?.readbackToken,
      });
      response.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof OrderValidationError) return response.status(400).json({ error: error.message });
      response.status(500).json({ error: 'This order could not be saved. Please review the order and try again.' });
    }
  });

  if (process.env.NODE_ENV === 'production' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const distPath = join(here, '..', 'dist');
    app.use(express.static(distPath));
    app.get('*', (_request, response) => response.sendFile(join(distPath, 'index.html')));
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: `Recording is too large. Please keep it under ${Math.floor(maxAudioBytes / (1024 * 1024))} MB.` });
    }
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'The request payload is too large.' });
    response.status(400).json({ error: 'The request could not be processed.' });
  });

  return app;
}

export function parseWavDuration(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new OrderValidationError('Audio conversion did not produce a supported WAV file.');
  }
  let offset = 12;
  let byteRate = 0;
  let dataLength = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= buffer.length) {
    const chunkName = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunkName === 'fmt ' && chunkSize >= 16 && start + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      byteRate = buffer.readUInt32LE(start + 8);
      bits = buffer.readUInt16LE(start + 14);
    }
    if (chunkName === 'data') dataLength = Math.min(chunkSize, buffer.length - start);
    offset = start + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || channels !== 1 || sampleRate < 8000 || sampleRate > 44100 || bits !== 16 || dataLength === 0) {
    throw new OrderValidationError('Audio must be mono, 16-bit WAV between 8 kHz and 44.1 kHz.');
  }
  const seconds = dataLength / byteRate;
  if (seconds < 0.1) throw new OrderValidationError('The recording was too short to transcribe. Please record again.');
  if (seconds > 30) throw new OrderValidationError('Recordings must be 30 seconds or shorter.');
  return seconds;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  createApp().listen(port, () => {
    console.log(`BolBahi backend listening on http://localhost:${port}`);
  });
}
