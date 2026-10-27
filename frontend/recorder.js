// Mic -> 16 kHz mono 16-bit WAV in the browser (the Meta Voice API takes WAV only; no ffmpeg needed).

const TARGET_RATE = 16000;
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);`;

export class Recorder {
  constructor({ onLevel, maxSeconds = 120, onAutoStop } = {}) {
    this.onLevel = onLevel;
    this.maxSeconds = maxSeconds;
    this.onAutoStop = onAutoStop;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.chunks = [];
    this.length = 0;
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture");
    this.node.port.onmessage = (e) => {
      this.chunks.push(e.data);
      this.length += e.data.length;
      this.onLevel?.(rms(e.data));
      if (this.length >= this.maxSeconds * this.ctx.sampleRate) this.onAutoStop?.();
    };
    // A silent path to the speakers keeps the worklet running in every browser.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  async stop() {
    const rate = this.ctx.sampleRate;
    this.stream.getTracks().forEach((t) => t.stop());
    this.node.port.onmessage = null;
    await this.ctx.close();

    const raw = new Float32Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      raw.set(c, offset);
      offset += c.length;
    }
    const pcm = await resample(raw, rate, TARGET_RATE);
    return { blob: encodeWav(pcm, TARGET_RATE), seconds: pcm.length / TARGET_RATE };
  }
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export async function resample(samples, fromRate, toRate) {
  if (!samples.length) return new Float32Array(0);
  if (fromRate === toRate) return samples;
  const frames = Math.ceil((samples.length * toRate) / fromRate);
  const offline = new OfflineAudioContext(1, frames, toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}

export function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (pos, s) => [...s].forEach((ch, i) => view.setUint8(pos + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}
