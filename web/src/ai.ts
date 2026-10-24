import * as tf from '@tensorflow/tfjs'
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch'
import { analyze, type Analysis, type MidiNote } from './analysis'

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json'
const RATE = 22050
const cancelled = () => new DOMException('Analysis cancelled', 'AbortError')

async function monoAtModelRate(input: AudioBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, Math.ceil(input.duration * RATE), RATE)
  const source = context.createBufferSource()
  source.buffer = input
  source.connect(context.destination)
  source.start()
  return (await context.startRendering()).getChannelData(0)
}

function splitPitchedNotes(notes: MidiNote[]) {
  const bass: MidiNote[] = [], lead: MidiNote[] = [], harmony: MidiNote[] = []
  for (const note of notes) {
    if (note.pitch < 60) { bass.push(note); continue }
    const midpoint = (note.start + note.end) / 2
    const highest = notes.some(other => other !== note && other.pitch > note.pitch && other.pitch >= 60 && other.start <= midpoint && other.end >= midpoint)
    ;(highest ? harmony : lead).push(note)
  }
  return { bass, lead, harmony }
}

export async function analyzeWithBasicPitch(input: AudioBuffer, progress: (fraction: number, stage: string) => void, signal: AbortSignal): Promise<Analysis> {
  if (input.duration < 1 || input.duration > 180) throw new Error('Use one second to three minutes of audio.')
  progress(0, 'Estimating drum onsets and tempo')
  const quick = await analyze(input, fraction => progress(0.18 * fraction, 'Estimating drum onsets and tempo'), signal)
  if (signal.aborted) throw cancelled()
  progress(0.18, 'Preparing audio for Basic Pitch')
  const samples = await monoAtModelRate(input)
  if (signal.aborted) throw cancelled()
  progress(0.22, 'Loading Basic Pitch model')
  const model = new BasicPitch(MODEL_URL)
  await model.model
  const frames: number[][] = [], onsets: number[][] = []
  tf.engine().startScope()
  try {
    await model.evaluateModel(samples, (f, o) => {
      if (signal.aborted) throw cancelled()
      frames.push(...f); onsets.push(...o)
    }, fraction => {
      if (signal.aborted) throw cancelled()
      progress(0.25 + 0.72 * fraction, 'Transcribing pitched notes')
    })
  } finally { tf.engine().endScope() }
  if (signal.aborted) throw cancelled()
  const notes: MidiNote[] = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.28, 0.28, 5))
    .filter(note => note.durationSeconds >= 0.09)
    .map(note => ({
      pitch: note.pitchMidi,
      start: Math.max(0, note.startTimeSeconds),
      end: Math.min(input.duration, note.startTimeSeconds + note.durationSeconds),
      velocity: Math.max(35, Math.min(120, Math.round(45 + note.amplitude * 75))),
      confidence: Math.max(0, Math.min(1, note.amplitude)),
    }))
    .filter(note => note.end > note.start)
  const groups = splitPitchedNotes(notes)
  const average = (items: MidiNote[]) => items.length ? items.reduce((sum, note) => sum + note.confidence, 0) / items.length : 0
  progress(1, 'Complete')
  return {
    duration: input.duration,
    tempo: quick.tempo,
    parts: quick.parts.map(part => part.id === 'drums' ? part : ({
      ...part,
      notes: groups[part.id as keyof typeof groups],
      confidence: average(groups[part.id as keyof typeof groups]),
    })),
    warnings: [
      'Basic Pitch transcribed the full mix locally. Bass, lead and harmony tracks are grouped by pitch and overlap; they are not isolated instruments.',
      'Drums, tempo and General MIDI programs are estimates. Dense mixes and vocals can cause missed or extra notes.',
    ],
  }
}
