import type { Analysis, MidiNote, Part } from './analysis'

const PPQ = 480
const bytes = (...values: number[]) => values.map(v => v & 255)
const u16 = (n: number) => bytes(n >> 8, n)
const u32 = (n: number) => bytes(n >> 24, n >> 16, n >> 8, n)
const chunk = (tag: string, body: number[]) => [...Array.from(tag).map(c => c.charCodeAt(0)), ...u32(body.length), ...body]
const varlen = (n: number) => {
  const out = [n & 127]
  while ((n >>= 7) > 0) out.unshift((n & 127) | 128)
  return out
}
const text = (s: string) => Array.from(new TextEncoder().encode(s))

type Event = { tick: number; priority: number; data: number[] }
function track(events: Event[]) {
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority)
  let last = 0
  const body: number[] = []
  for (const event of events) {
    body.push(...varlen(Math.max(0, event.tick - last)), ...event.data)
    last = event.tick
  }
  body.push(0, 0xff, 0x2f, 0)
  return chunk('MTrk', body)
}
function noteEvents(notes: MidiNote[], channel: number, ticksPerSecond: number): Event[] {
  return notes.flatMap(note => {
    const start = Math.max(0, Math.round(note.start * ticksPerSecond))
    const end = Math.max(start + 1, Math.round(note.end * ticksPerSecond))
    return [
      { tick: start, priority: 1, data: bytes(0x90 | channel, note.pitch, note.velocity) },
      { tick: end, priority: 0, data: bytes(0x80 | channel, note.pitch, 0) },
    ]
  })
}
function partTrack(part: Part, channel: number, ticksPerSecond: number) {
  const name = text(part.name)
  const events: Event[] = [{ tick: 0, priority: -2, data: [0xff, 0x03, ...varlen(name.length), ...name] }]
  if (channel !== 9) events.push({ tick: 0, priority: -1, data: bytes(0xc0 | channel, part.program) })
  events.push(...noteEvents(part.notes, channel, ticksPerSecond))
  return track(events)
}

export function encodeMidi(analysis: Analysis): Uint8Array {
  const tempo = Math.max(40, Math.min(240, Math.round(analysis.tempo)))
  const micros = Math.round(60_000_000 / tempo)
  const tempoTrack = track([
    { tick: 0, priority: -2, data: [0xff, 0x51, 3, ...bytes(micros >> 16, micros >> 8, micros)] },
    { tick: 0, priority: -1, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
  ])
  const ticksPerSecond = PPQ * tempo / 60
  const parts = analysis.parts.filter(p => p.notes.length)
  const tracks = parts.map((p, i) => partTrack(p, p.id === 'drums' ? 9 : [0, 1, 2, 3, 4, 5][i % 6], ticksPerSecond))
  return new Uint8Array([...chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(PPQ)]), ...tempoTrack, ...tracks.flat()])
}
