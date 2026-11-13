import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resampleWavTo16kMono } from './wav.js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(here, '..', '.env'));
} catch {
  // The optional smoke test can still use a key supplied by the process environment.
}

if (!process.env.GNANI_API_KEY) {
  console.log('Gnani API smoke skipped: GNANI_API_KEY is not configured in the backend environment.');
  process.exit(0);
}

let smokeStage = 'Timbre v2.5 TTS';

async function runSmoke() {
  const ttsResponse = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
    method: 'POST',
    headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Do kilo chawal.',
      model: 'timbre-v2.5',
      voice: 'Poorvi',
      language: 'hi-en',
      speed: 1,
      audio_config: { encoding: 'linear_pcm', container: 'wav', num_channels: 1, sample_rate: 48000, sample_width: 2 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!ttsResponse.ok) throw new Error(`TTS HTTP ${ttsResponse.status}`);
  if (!(ttsResponse.headers.get('content-type') || '').toLowerCase().startsWith('audio/')) throw new Error('TTS response was not audio');
  const sourceWav = Buffer.from(await ttsResponse.arrayBuffer());
  if (!sourceWav.length) throw new Error('TTS returned empty audio');
  const wav = resampleWavTo16kMono(sourceWav);

  smokeStage = 'Prisma v3.0 STT';
  const form = new FormData();
  form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'smoke.wav');
  form.append('model', 'prisma-v3.0');
  form.append('language_code', 'indic-auto');
  form.append('format', 'codemix');
  const sttResponse = await fetch('https://api.vachana.ai/stt/v3', {
    method: 'POST',
    headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!sttResponse.ok) throw new Error(`STT HTTP ${sttResponse.status}`);
  const transcript = await sttResponse.json();
  if (transcript.success !== true || !transcript.transcript?.trim()) throw new Error('STT response did not contain a transcript');
  if (transcript.model !== 'prisma-v3.0') throw new Error('STT returned a different model');
  console.log('Gnani API smoke passed: Timbre v2.5 returned WAV audio and Prisma v3.0 returned a transcript.');
}

runSmoke().catch((error) => {
  const status = error.message.match(/HTTP \d+/)?.[0];
  const safeCode = error.cause?.code;
  console.error(`Gnani API smoke failed during ${smokeStage}${status ? ` (${status})` : safeCode ? ` (${safeCode})` : ''}. Provider response details and credentials were withheld.`);
  process.exitCode = 1;
});

