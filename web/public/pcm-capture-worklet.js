class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSamples = 1600;
    this.samples = new Int16Array(this.chunkSamples);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!input) return true;

    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      this.samples[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.chunkSamples) {
        const chunk = this.samples;
        this.port.postMessage(chunk.buffer, [chunk.buffer]);
        this.samples = new Int16Array(this.chunkSamples);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16CaptureProcessor);
