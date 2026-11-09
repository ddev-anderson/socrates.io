const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_BYTES = 44;

export function createMockWav(text) {
  const durationSeconds = Math.min(3.2, Math.max(0.5, String(text).length * 0.04));
  const sampleCount = Math.floor(SAMPLE_RATE * durationSeconds);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = sampleCount * blockAlign;
  const buffer = Buffer.alloc(HEADER_BYTES + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Um bipe curto e suave no início; o restante fica em silêncio.
  // Serve apenas para exercitar fila de áudio, orbe e temporização antes do Qwen.
  const blipSamples = Math.min(sampleCount, Math.floor(SAMPLE_RATE * 0.12));
  for (let i = 0; i < blipSamples; i += 1) {
    const envelope = 1 - i / blipSamples;
    const sample =
      Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.06 * envelope;
    buffer.writeInt16LE(Math.round(sample * 32767), HEADER_BYTES + i * 2);
  }

  return buffer;
}

export function createMockSpeechStream(text) {
  const wav = createMockWav(text);
  const audio = wav.toString("base64");
  const audioMs = Math.round(((wav.length - HEADER_BYTES) / 2 / SAMPLE_RATE) * 1000);

  const events = [
    ": connected\n\n",
    `data: ${JSON.stringify({
      index: 0,
      audio,
      final: true,
      sample_rate: SAMPLE_RATE,
      audio_ms: audioMs,
    })}\n\n`,
    `data: ${JSON.stringify({ type: "done", chunks: 1, total_ms: 0 })}\n\n`,
  ];

  return events.join("");
}
