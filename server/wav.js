function readChunks(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV container');
  }
  let format;
  let audio;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error('Invalid WAV chunk length');
    if (name === 'fmt ') {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    }
    if (name === 'data') audio = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !audio || format.encoding !== 1 || format.bits !== 16 || format.channels < 1 || format.channels > 8 || !format.sampleRate) {
    throw new Error('WAV must contain PCM 16-bit audio');
  }
  return { ...format, audio };
}

export function resampleWavTo16kMono(buffer) {
  const source = readChunks(buffer);
  const sourceFrames = Math.floor(source.audio.length / (source.channels * 2));
  const targetFrames = Math.floor(sourceFrames * 16000 / source.sampleRate);
  if (targetFrames < 1600 || targetFrames > 30 * 16000) throw new Error('WAV duration is outside the supported range');
  const pcmBytes = targetFrames * 2;
  const output = Buffer.alloc(44 + pcmBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + pcmBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16000, 24);
  output.writeUInt32LE(32000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(pcmBytes, 40);

  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = frame * source.sampleRate / 16000;
    const before = Math.floor(sourcePosition);
    const after = Math.min(before + 1, sourceFrames - 1);
    const ratio = sourcePosition - before;
    let sample = 0;
    for (let channel = 0; channel < source.channels; channel += 1) {
      const first = source.audio.readInt16LE((before * source.channels + channel) * 2);
      const second = source.audio.readInt16LE((after * source.channels + channel) * 2);
      sample += first * (1 - ratio) + second * ratio;
    }
    const mono = Math.max(-32768, Math.min(32767, Math.round(sample / source.channels)));
    output.writeInt16LE(mono, 44 + frame * 2);
  }
  return output;
}

