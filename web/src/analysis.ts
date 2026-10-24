export type MidiNote = { pitch: number; start: number; end: number; velocity: number; confidence: number }
export type Part = { id: string; name: string; program: number; notes: MidiNote[]; confidence: number; color: string; muted: boolean; solo: boolean }
export type Analysis = { parts: Part[]; tempo: number; duration: number; warnings: string[] }

const RATE = 11025
const SIZE = 2048
const HOP = 256
const MIN_PITCH = 36
const MAX_PITCH = 88
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const twiddles = new Map<number, { cos: Float32Array; sin: Float32Array }>()
for (let len = 2; len <= SIZE; len <<= 1) {
  const cos = new Float32Array(len / 2), sin = new Float32Array(len / 2)
  for (let j = 0; j < len / 2; j++) { cos[j] = Math.cos(-2 * Math.PI * j / len); sin[j] = Math.sin(-2 * Math.PI * j / len) }
  twiddles.set(len, { cos, sin })
}
const windowCoefficients = Float32Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SIZE - 1)))

function fft(real: Float32Array, imag: Float32Array) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const { cos, sin } = twiddles.get(len)!
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < len / 2; j++) {
        const c = cos[j], s = sin[j]
        const a = i + j, b = a + len / 2
        const tr = real[b] * c - imag[b] * s, ti = real[b] * s + imag[b] * c
        real[b] = real[a] - tr; imag[b] = imag[a] - ti
        real[a] += tr; imag[a] += ti
      }
    }
  }
}

function spectralPeak(mag: Float32Array, bin: number) {
  const i = Math.round(bin)
  if (i < 2 || i > mag.length - 3) return 0
  return Math.max(mag[i - 1], mag[i], mag[i + 1])
}

function toMono(buffer: AudioBuffer) {
  const length = Math.floor(buffer.duration * RATE)
  const out = new Float32Array(length)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  for (let i = 0; i < length; i++) {
    const source = i * buffer.sampleRate / RATE
    const j = Math.floor(source), f = source - j
    for (const channel of channels) out[i] += ((channel[j] ?? 0) * (1 - f) + (channel[j + 1] ?? 0) * f) / channels.length
  }
  return out
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function notesFromFrames(frames: number[][], threshold: number, duration: number): MidiNote[] {
  const result: MidiNote[] = []
  const count = frames[0]?.length ?? 0
  const dt = HOP / RATE
  for (let pitchIndex = 0; pitchIndex < count; pitchIndex++) {
    let start = -1, last = -1, peak = 0
    const flush = () => {
      if (start < 0 || last - start < 3) return
      const confidence = clamp(peak, 0, 1)
      result.push({ pitch: MIN_PITCH + pitchIndex, start: start * dt, end: Math.min(duration, (last + 1) * dt), velocity: Math.round(50 + 65 * confidence), confidence })
    }
    for (let f = 0; f < frames.length; f++) {
      const value = frames[f][pitchIndex] ?? 0
      if (value > threshold) {
        if (start < 0) start = f
        last = f; peak = Math.max(peak, value)
      } else if (start >= 0 && f - last > 2) {
        flush(); start = -1; peak = 0
      }
    }
    flush()
  }
  return result.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

function detectDrums(flux: number[][], duration: number): MidiNote[] {
  const out: MidiNote[] = []
  const pitches = [36, 38, 42]
  for (let band = 0; band < 3; band++) {
    const series = flux.map(row => row[band])
    const threshold = Math.max(0.25, median(series) * 3.2, Math.max(...series) * 0.2)
    let last = -10
    for (let i = 2; i < series.length - 2; i++) {
      const v = series[i]
      if (v < threshold || v < series[i - 1] || v < series[i + 1] || (i - last) * HOP / RATE < 0.09) continue
      const confidence = clamp(v / (threshold * 3), 0.25, 1)
      const start = i * HOP / RATE
      out.push({ pitch: pitches[band], start, end: Math.min(duration, start + 0.085), velocity: Math.round(55 + 60 * confidence), confidence })
      last = i
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

function tempoFromOnsets(notes: MidiNote[]) {
  const times = notes.filter(n => n.pitch === 36 || n.pitch === 38).map(n => n.start)
  if (times.length < 4) return 120
  let best = 120, score = -Infinity
  for (let bpm = 60; bpm <= 180; bpm++) {
    const period = 60 / bpm
    let s = 0
    for (let i = 0; i < times.length; i++) for (let j = i + 1; j < times.length && times[j] - times[i] < 2.1; j++) {
      const phase = (times[j] - times[i]) / period
      s += Math.exp(-(((phase - Math.round(phase)) / 0.12) ** 2))
    }
    if (s > score) { best = bpm; score = s }
  }
  return best
}

export async function analyze(buffer: AudioBuffer, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Analysis> {
  if (buffer.duration < 1) throw new Error('Use at least one second of audio.')
  if (buffer.duration > 180) throw new Error('This version analyzes up to three minutes. Trim the recording first.')
  const mono = toMono(buffer)
  const frameCount = Math.max(0, Math.floor((mono.length - SIZE) / HOP))
  const real = new Float32Array(SIZE), imag = new Float32Array(SIZE), mag = new Float32Array(SIZE / 2)
  const previousBandEnergy = [0, 0, 0]
  const bassFrames: number[][] = [], leadFrames: number[][] = [], chordFrames: number[][] = [], flux: number[][] = []
  const bins = Array.from({ length: MAX_PITCH - MIN_PITCH + 1 }, (_, i) => hz(MIN_PITCH + i) * SIZE / RATE)
  for (let frame = 0; frame < frameCount; frame++) {
    if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError')
    const offset = frame * HOP
    for (let i = 0; i < SIZE; i++) { real[i] = mono[offset + i] * windowCoefficients[i]; imag[i] = 0 }
    fft(real, imag)
    for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(real[i], imag[i])
    const raw = bins.map(bin => {
      const fundamental = spectralPeak(mag, bin), second = spectralPeak(mag, bin * 2)
      const score = fundamental + 0.55 * second + 0.25 * spectralPeak(mag, bin * 3)
      return fundamental < second * 0.22 ? score * 0.1 : score
    })
    const peak = Math.max(...raw, 1e-8)
    const norm = raw.map(v => v / peak)
    const selectedBass = Array(norm.length).fill(0), selectedLead = Array(norm.length).fill(0), selectedChord = Array(norm.length).fill(0)
    const bassRange = norm.map((v, i) => MIN_PITCH + i <= 59 ? v : 0)
    const bassIndex = bassRange.indexOf(Math.max(...bassRange))
    if (norm[bassIndex] > 0.33) selectedBass[bassIndex] = norm[bassIndex]
    const leadRange = norm.map((v, i) => MIN_PITCH + i >= 60 && Math.abs(i - bassIndex) > 2 ? v : 0)
    const leadIndex = leadRange.indexOf(Math.max(...leadRange))
    if (norm[leadIndex] > 0.27) selectedLead[leadIndex] = norm[leadIndex]
    const candidates = norm.map((v, i) => ({ v, i })).filter(x => x.i + MIN_PITCH >= 48 && Math.abs(x.i - bassIndex) > 2 && Math.abs(x.i - leadIndex) > 2 && x.v > 0.32).sort((a, b) => b.v - a.v).slice(0, 2)
    for (const item of candidates) selectedChord[item.i] = item.v
    bassFrames.push(selectedBass); leadFrames.push(selectedLead); chordFrames.push(selectedChord)
    const bandEnergy = [0, 0, 0]
    for (let i = 4; i < mag.length; i++) {
      const f = i * RATE / SIZE
      const band = f < 180 ? 0 : f < 1800 ? 1 : 2
      bandEnergy[band] += mag[i] * mag[i]
    }
    const row = bandEnergy.map((energy, band) => Math.max(0, Math.log1p(energy) - Math.log1p(previousBandEnergy[band])))
    for (let band = 0; band < 3; band++) previousBandEnergy[band] = bandEnergy[band]
    flux.push(row)
    if (frame % 120 === 0) { onProgress(frame / frameCount); await new Promise<void>(resolve => setTimeout(resolve, 0)) }
  }
  const bass = notesFromFrames(bassFrames, 0.31, buffer.duration)
  const lead = notesFromFrames(leadFrames, 0.27, buffer.duration)
  const harmony = notesFromFrames(chordFrames, 0.33, buffer.duration)
  const drums = detectDrums(flux, buffer.duration)
  const avg = (notes: MidiNote[]) => notes.length ? notes.reduce((a, n) => a + n.confidence, 0) / notes.length : 0
  onProgress(1)
  return {
    duration: buffer.duration,
    tempo: tempoFromOnsets(drums),
    parts: [
      { id: 'drums', name: 'Drum candidates', program: 0, notes: drums, confidence: avg(drums), color: '#e96767', muted: false, solo: false },
      { id: 'bass', name: 'Bass candidates', program: 33, notes: bass, confidence: avg(bass), color: '#e7ae58', muted: false, solo: false },
      { id: 'lead', name: 'Lead candidates', program: 80, notes: lead, confidence: avg(lead), color: '#7eafff', muted: false, solo: false },
      { id: 'harmony', name: 'Harmony candidates', program: 0, notes: harmony, confidence: avg(harmony), color: '#aa85eb', muted: false, solo: false },
    ],
    warnings: ['Parts are estimated by frequency range and transients. They are not isolated audio stems.', 'Instrument labels and tempo are suggestions. Dense mixes, vocals and effects can produce extra or missed notes.'],
  }
}
