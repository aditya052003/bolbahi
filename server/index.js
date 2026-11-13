import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOrderService, OrderValidationError } from './order-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3001);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const orderService = createOrderService({ storagePath: join(here, 'data', 'orders.json') });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, speechConfigured: Boolean(process.env.GNANI_API_KEY) });
});

function requireGnaniKey(response) {
  if (process.env.GNANI_API_KEY) return true;
  response.status(503).json({ error: 'Gnani speech is not configured. Add GNANI_API_KEY to the backend .env file.' });
  return false;
}

function parseWavDuration(buffer) {
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

app.post('/api/transcribe', upload.single('audio_file'), async (request, response) => {
  if (!requireGnaniKey(response)) return;
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
    const upstream = await fetch('https://api.vachana.ai/stt/v3', {
      method: 'POST',
      headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY },
      body: form,
      signal: AbortSignal.timeout(60_000),
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
  if (!requireGnaniKey(response)) return;
  let prepared;
  try {
    prepared = await orderService.prepareReadback(request.body?.items);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  try {
    const upstream = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
      method: 'POST',
      headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: prepared.readbackText,
        model: 'timbre-v2.5',
        voice: 'Poorvi',
        language: 'hi-en',
        speed: 1.0,
        audio_config: { encoding: 'linear_pcm', container: 'wav', num_channels: 1, sample_rate: 48000, sample_width: 2 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok) return response.status(502).json({ error: 'Gnani could not read back this order. No order was saved.' });
    const contentType = upstream.headers.get('content-type') || '';
    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!contentType.toLowerCase().startsWith('audio/') || audio.length === 0) {
      return response.status(502).json({ error: 'Gnani returned an unsupported audio response. No order was saved.' });
    }
    const readbackToken = orderService.issueReadback(prepared.digest);
    response.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Readback-Token': readbackToken });
    return response.send(audio);
  } catch {
    return response.status(502).json({ error: 'Gnani speech service could not be reached. No order was saved.' });
  }
});

app.get('/api/orders', async (_request, response) => {
  try {
    response.json({ orders: await orderService.list() });
  } catch {
    response.status(500).json({ error: 'Saved order history could not be loaded.' });
  }
});

app.post('/api/orders', async (request, response) => {
  try {
    const result = await orderService.confirm({
      items: request.body?.items,
      confirmed: request.body?.confirmed,
      readbackToken: request.body?.readbackToken,
    });
    response.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof OrderValidationError) return response.status(400).json({ error: error.message });
    response.status(500).json({ error: 'This order could not be saved locally. Please review the order and try again.' });
  }
});

const distPath = join(here, '..', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath));
  app.get('*', (_request, response) => response.sendFile(join(distPath, 'index.html')));
}

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'Recording is too large. Please keep it under 8 MB.' });
  }
  response.status(400).json({ error: 'The request could not be processed.' });
});

app.listen(port, () => {
  console.log(`BolBahi backend listening on http://localhost:${port}`);
});

