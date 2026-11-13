import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleWavTo16kMono } from '../server/wav.js';

function makePcmWav({ seconds = 1, sampleRate = 48000, channels = 1 } = {}) {
  const frames = seconds * sampleRate;
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 44; index < buffer.length; index += 2) buffer.writeInt16LE(index % 128, index);
  return buffer;
}

test('WAV conversion produces mono 16 kHz PCM accepted by the STT upload path', () => {
  const converted = resampleWavTo16kMono(makePcmWav({ seconds: 2, channels: 2 }));
  assert.equal(converted.toString('ascii', 0, 4), 'RIFF');
  assert.equal(converted.toString('ascii', 8, 12), 'WAVE');
  assert.equal(converted.readUInt16LE(22), 1);
  assert.equal(converted.readUInt32LE(24), 16000);
  assert.equal(converted.readUInt16LE(34), 16);
  assert.equal(converted.readUInt32LE(40), 64000);
  assert.equal(converted.length, 64044);
});

test('WAV conversion rejects malformed or too-short audio instead of guessing', () => {
  assert.throws(() => resampleWavTo16kMono(Buffer.from('not audio')), /Invalid WAV/);
  assert.throws(() => resampleWavTo16kMono(makePcmWav({ seconds: 0.05 })), /duration/);
});

