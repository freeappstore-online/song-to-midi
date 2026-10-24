import { useEffect, useRef, useState } from 'react'
import { initApp } from '@freeappstore/sdk'
import { type NavItem, PageHeader, Shell, useToast } from '@freeappstore/sdk/ui'
import { analyze, type Analysis, type MidiNote, type Part } from './analysis'
import { encodeMidi } from './midi'
import { analyzeWithBasicPitch } from './ai'

const fas = initApp({ appId: 'song-to-midi' })
const NAV: NavItem[] = [
  { label: 'Studio', href: '/', title: 'Song to MIDI Studio' },
  { label: 'How it works', href: '/about', title: 'How it works — Song to MIDI Studio' },
]
const PROGRAMS = [
  [0, 'Acoustic grand piano'], [4, 'Electric piano'], [24, 'Nylon guitar'], [25, 'Steel guitar'],
  [30, 'Distortion guitar'], [32, 'Acoustic bass'], [33, 'Fingered bass'], [34, 'Picked bass'],
  [40, 'Violin'], [42, 'Cello'], [48, 'String ensemble'], [52, 'Choir'], [56, 'Trumpet'],
  [65, 'Alto sax'], [73, 'Flute'], [80, 'Square lead'], [81, 'Saw lead'], [88, 'New age pad'],
] as const
const noteName = (pitch: number) => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][pitch % 12]}${Math.floor(pitch / 12) - 1}`
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export default function App() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => { const sync = () => setPath(location.pathname); addEventListener('popstate', sync); return () => removeEventListener('popstate', sync) }, [])
  const navigate = (href: string) => { history.pushState(null, '', href); setPath(href) }
  return <Shell app={fas} appName="Song to MIDI Studio" nav={NAV} onNavigate={navigate}>
    <div className="studio-wrap">{path === '/about' ? <About /> : <Studio />}</div>
  </Shell>
}

function About() {
  return <>
    <PageHeader title="How it works" description="A local, editable MIDI sketch from a recording." />
    <div className="panel prose">
      <h2>What this version analyzes</h2>
      <p>Capture sound from another browser tab or open an audio file. The app decodes it in your browser, estimates bass, upper lead and harmony notes using either harmonic peaks or a local pitch model, and estimates kick, snare and hi-hat events from spectral transients. It writes separate tracks to a standard MIDI file. Recording and note data stay in this tab and disappear when you close it.</p>
      <h2>Accuracy</h2>
      <p>Fast mode uses frequency and transient estimates. AI note mode downloads the free Spotify Basic Pitch model and transcribes pitched notes locally. It groups notes into approximate bass, lead and harmony tracks by range and overlap; it does not isolate instruments. Both modes can miss notes. Program choices are editable suggestions. A General MIDI soundfont in a DAW will usually sound better than the app’s simple oscillator preview, and MIDI cannot reproduce every detail of a studio recording.</p>
      <h2>Capture</h2>
      <p>Choose “Record browser tab,” select the tab playing your song and enable audio sharing in the browser picker. Some browsers and protected media do not provide tab audio. The local file option works independently of tab capture. Use recordings you have permission to process.</p>
    </div>
  </>
}

function Studio() {
  const toast = useToast()
  const [audio, setAudio] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordingLevel, setRecordingLevel] = useState(0)
  const [recordingBytes, setRecordingBytes] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [analysisStage, setAnalysisStage] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [selected, setSelected] = useState<{ part: string; index: number } | null>(null)
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState<'original' | 'midi' | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const capture = useRef<MediaStream | null>(null)
  const abort = useRef<AbortController | null>(null)
  const context = useRef<AudioContext | null>(null)
  const original = useRef<HTMLAudioElement | null>(null)
  const timer = useRef<number | null>(null)
  const recordTick = useRef<number | null>(null)
  const levelFrame = useRef<number | null>(null)
  const recordLimit = useRef<number | null>(null)
  const meterContext = useRef<AudioContext | null>(null)

  const stopRecordingMonitors = () => {
    if (recordTick.current !== null) { clearInterval(recordTick.current); recordTick.current = null }
    if (levelFrame.current !== null) { cancelAnimationFrame(levelFrame.current); levelFrame.current = null }
    if (recordLimit.current !== null) { clearTimeout(recordLimit.current); recordLimit.current = null }
    if (meterContext.current) { void meterContext.current.close(); meterContext.current = null }
    setRecordingLevel(0)
  }

  const stopAudio = () => {
    original.current?.pause()
    if (context.current) { void context.current.close(); context.current = null }
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    setPlaying(null)
  }
  const replaceAudio = (blob: Blob, name: string) => {
    stopAudio(); abort.current?.abort(); setAnalysis(null); setSelected(null); setProgress(0)
    setAudio(blob); setSourceName(name)
    setAudioUrl(old => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob) })
  }
  useEffect(() => () => {
    abort.current?.abort()
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    capture.current?.getTracks().forEach(track => track.stop())
    if (recordTick.current !== null) clearInterval(recordTick.current)
    if (levelFrame.current !== null) cancelAnimationFrame(levelFrame.current)
    if (recordLimit.current !== null) clearTimeout(recordLimit.current)
    if (meterContext.current) void meterContext.current.close()
    if (context.current) void context.current.close()
    original.current?.pause()
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])

  const recordTab = async () => {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('No tab audio was shared. Select a tab and enable audio in the picker.') }
      const audioStream = new MediaStream(stream.getAudioTracks())
      const sharedStream = stream
      const chunks: BlobPart[] = []
      const media = new MediaRecorder(audioStream)
      capture.current = stream; recorder.current = media
      media.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); setRecordingBytes(value => value + e.data.size) } }
      media.onstop = () => {
        stopRecordingMonitors()
        sharedStream.getTracks().forEach(t => t.stop()); capture.current = null; recorder.current = null; setRecording(false)
        if (chunks.length) replaceAudio(new Blob(chunks, { type: media.mimeType || 'audio/webm' }), `Tab recording ${new Date().toLocaleTimeString()}`)
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (media.state !== 'inactive') media.stop() }, { once: true })
      stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (media.state !== 'inactive') media.stop() }, { once: true })
      media.start(1000); setRecording(true); setRecordingSeconds(0); setRecordingBytes(0); setRecordingLevel(0)
      const started = performance.now()
      recordTick.current = window.setInterval(() => setRecordingSeconds(Math.min(180, Math.floor((performance.now() - started) / 1000))), 250)
      recordLimit.current = window.setTimeout(() => { if (media.state !== 'inactive') media.stop() }, 180_000)
      try {
        const ctx = new AudioContext(); meterContext.current = ctx
        void ctx.resume().catch(() => {})
        const source = ctx.createMediaStreamSource(audioStream), analyser = ctx.createAnalyser()
        analyser.fftSize = 1024; source.connect(analyser)
        const samples = new Uint8Array(analyser.fftSize)
        const updateLevel = () => {
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value }
          setRecordingLevel(Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 280)))
          levelFrame.current = requestAnimationFrame(updateLevel)
        }
        updateLevel()
      } catch { if (meterContext.current) { void meterContext.current.close(); meterContext.current = null }; setRecordingLevel(0) }
    } catch (error) { stream?.getTracks().forEach(t => t.stop()); stopRecordingMonitors(); toast.show(error instanceof Error ? error.message : 'Could not record this tab.', { variant: 'error' }) }
  }
  const stopRecording = () => { if (recorder.current?.state !== 'inactive') recorder.current?.stop() }
  const run = async (mode: 'fast' | 'ai') => {
    if (!audio) return
    stopAudio(); setBusy(true); setProgress(0); setAnalysis(null); setAnalysisStage(mode === 'ai' ? 'Preparing AI note analysis' : 'Estimating notes')
    const controller = new AbortController(); abort.current = controller
    let decoder: AudioContext | null = null
    try {
      decoder = new AudioContext()
      const buffer = await decoder.decodeAudioData(await audio.arrayBuffer())
      if (controller.signal.aborted) return
      if (mode === 'ai') {
        const result = await analyzeWithBasicPitch(buffer, (fraction, stage) => { setProgress(fraction); setAnalysisStage(stage) }, controller.signal)
        setAnalysis(result)
      } else {
        const result = await analyze(buffer, setProgress, controller.signal)
        setAnalysis(result)
      }
      setCursor(0); toast.show('MIDI sketch ready. Review the notes before export.', { variant: 'success' })
    } catch (error) { if (!controller.signal.aborted) toast.show(error instanceof Error ? error.message : 'Audio analysis failed.', { variant: 'error' }) }
    finally { if (decoder) void decoder.close(); if (abort.current === controller) abort.current = null; setBusy(false) }
  }
  const changePart = (id: string, update: Partial<Part>) => setAnalysis(old => old && ({ ...old, parts: old.parts.map(p => p.id === id ? { ...p, ...update } : p) }))
  const changeNote = (partId: string, index: number, update: Partial<MidiNote>) => setAnalysis(old => old && ({ ...old, parts: old.parts.map(p => p.id === partId ? { ...p, notes: p.notes.map((n, i) => i === index ? { ...n, ...update } : n) } : p) }))
  const exportMidi = () => {
    if (!analysis) return
    const data = encodeMidi(analysis)
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/midi' }))
    const link = document.createElement('a'); link.href = url; link.download = `${sourceName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').toLowerCase() || 'song'}-parts.mid`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const previewMidi = () => {
    if (!analysis) return
    stopAudio()
    const ctx = new AudioContext(); context.current = ctx
    const active = analysis.parts.filter(p => !p.muted && (!analysis.parts.some(x => x.solo) || p.solo))
    const maxTime = Math.min(analysis.duration, cursor + 30)
    for (const part of active) for (const note of part.notes) {
      if (note.end <= cursor || note.start >= maxTime) continue
      const start = ctx.currentTime + Math.max(0, note.start - cursor) + 0.05
      const end = ctx.currentTime + Math.min(maxTime, note.end) - cursor + 0.05
      if (end <= start) continue
      const oscillator = ctx.createOscillator(), gain = ctx.createGain()
      const program = part.program
      oscillator.type = part.id === 'drums' ? 'triangle' : program >= 80 ? 'sawtooth' : program >= 40 ? 'triangle' : program >= 24 && program < 40 ? 'sawtooth' : 'sine'
      oscillator.frequency.value = part.id === 'drums' ? note.pitch === 36 ? 70 : note.pitch === 38 ? 180 : 500 : 440 * 2 ** ((note.pitch - 69) / 12)
      const amp = 0.045 * note.velocity / 127 / Math.max(1, Math.sqrt(active.length))
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(amp, start + 0.012)
      gain.gain.setValueAtTime(amp, Math.max(start + 0.013, end - 0.04))
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain).connect(ctx.destination); oscillator.start(start); oscillator.stop(end + 0.01)
    }
    setPlaying('midi'); timer.current = window.setTimeout(stopAudio, (maxTime - cursor + 0.2) * 1000)
  }
  const previewOriginal = () => {
    if (!original.current) return
    stopAudio(); original.current.currentTime = cursor
    void original.current.play().then(() => setPlaying('original')).catch(() => toast.show('Playback was blocked by the browser.', { variant: 'error' }))
  }
  const selectedPart = analysis?.parts.find(p => p.id === selected?.part)
  const selectedNote = selectedPart?.notes[selected?.index ?? -1]

  return <>
    <PageHeader title="Song to MIDI Studio" description="Capture a recording, inspect estimated parts, and export editable multitrack MIDI." />
    <section className="panel">
      <h2>1. Choose a recording</h2>
      <p className="muted">Select the song’s browser tab and share its audio, as in Karaoke. Or open a file. Audio stays in this browser tab.</p>
      <div className="actions">
        <button type="button" onClick={recording ? stopRecording : recordTab} className="primary">{recording ? '■ Stop recording' : '● Record browser tab'}</button>
        <label className="file-button">Open audio file<input type="file" accept="audio/*" onChange={e => { const file = e.target.files?.[0]; if (file) replaceAudio(file, file.name) }} /></label>
      </div>
      {recording && <div className="recording-progress" role="status" aria-label="Recording progress">
        <div className="recording-progress-top"><strong><span className="recording-dot" /> Recording</strong><span>{timeLabel(recordingSeconds)} / 3:00</span></div>
        <progress value={recordingSeconds} max="180" aria-label="Recording time progress" />
        <div className="recording-progress-bottom"><label>Input level <meter min="0" max="100" value={recordingLevel} aria-label="Tab audio input level" /></label><span>{(recordingBytes / 1024 / 1024).toFixed(1)} MB captured</span></div>
        <p className="muted">Play the song in the shared tab, then return here and stop recording.</p>
      </div>}
      {audio && <div className="source"><strong>{sourceName}</strong><span>{(audio.size / 1024 / 1024).toFixed(1)} MB</span><audio ref={original} src={audioUrl} controls onEnded={() => setPlaying(null)} /></div>}
    </section>
    <section className="panel">
      <h2>2. Analyze and review</h2>
      <div className="actions"><button type="button" disabled={!audio || busy || recording} onClick={() => void run('fast')}>Fast note estimate</button><button type="button" className="primary" disabled={!audio || busy || recording} onClick={() => void run('ai')}>AI note transcription</button>{busy && <button type="button" onClick={() => abort.current?.abort()}>Cancel</button>}</div>
      <p className="muted">AI mode runs Spotify Basic Pitch in this browser. The small model downloads on first use; longer songs can take several minutes to transcribe.</p>
      {busy && <><progress value={progress} max="1" aria-label="Analysis progress" /><p className="muted">{analysisStage} · {Math.round(progress * 100)}%</p></>}
      {!analysis && <p className="muted">Fast mode estimates notes from spectral peaks. AI mode uses a trained pitch model to transcribe the mix, then groups notes into approximate bass, lead and harmony tracks. Neither mode separates audio stems.</p>}
      {analysis && <>
        <div className="summary"><span>{timeLabel(analysis.duration)} analyzed</span><span>~{analysis.tempo} BPM</span><span>{analysis.parts.reduce((n, p) => n + p.notes.length, 0)} note events</span></div>
        <div className="warning">{analysis.warnings.join(' ')}</div>
        <label className="cursor-label">Start playback at {timeLabel(cursor)}<input type="range" min="0" max={Math.max(0, analysis.duration - 1)} step="0.1" value={cursor} onChange={e => { stopAudio(); setCursor(Number(e.target.value)) }} /></label>
        <div className="actions"><button type="button" onClick={playing === 'original' ? stopAudio : previewOriginal}>{playing === 'original' ? 'Stop original' : '▶ Original'}</button><button type="button" onClick={playing === 'midi' ? stopAudio : previewMidi}>{playing === 'midi' ? 'Stop MIDI' : '▶ MIDI sketch (30s)'}</button></div>
        <div className="parts">{analysis.parts.map(part => <div className="part" key={part.id} style={{ borderLeftColor: part.color }}>
          <div className="part-top"><div><strong>{part.name}</strong><small>{part.notes.length} notes · average confidence {Math.round(part.confidence * 100)}%</small></div><div className="actions compact"><label><input type="checkbox" checked={part.muted} onChange={e => changePart(part.id, { muted: e.target.checked })} /> Mute</label><label><input type="checkbox" checked={part.solo} onChange={e => changePart(part.id, { solo: e.target.checked })} /> Solo</label></div></div>
          {part.id !== 'drums' && <label className="program">MIDI instrument <select value={part.program} onChange={e => changePart(part.id, { program: Number(e.target.value) })}>{PROGRAMS.map(([number, name]) => <option key={number} value={number}>{name}</option>)}</select></label>}
          <div className="piano-scroll"><div className="piano-roll" style={{ width: `${Math.max(600, analysis.duration * 13)}px` }} aria-label={`${part.name} piano roll`}>{part.notes.slice(0, 1200).map((note, index) => <button type="button" title={`${noteName(note.pitch)} at ${note.start.toFixed(2)}s · ${Math.round(note.confidence * 100)}% confidence`} key={`${index}-${note.start}`} className={`roll-note ${selected?.part === part.id && selected.index === index ? 'chosen' : ''}`} style={{ left: `${note.start * 13}px`, width: `${Math.max(4, (note.end - note.start) * 13)}px`, bottom: `${part.id === 'drums' ? (note.pitch - 35) * 7 : (note.pitch - 36) * 3}px`, background: part.color }} onClick={() => setSelected({ part: part.id, index })} />)}</div></div>
        </div>)}</div>
        {selectedNote && selectedPart && <div className="editor"><h3>Edit selected note · {selectedPart.name}</h3><div className="note-fields"><label>Pitch <input type="number" min="0" max="127" value={selectedNote.pitch} onChange={e => changeNote(selectedPart.id, selected!.index, { pitch: Math.max(0, Math.min(127, Number(e.target.value))) })} /></label><label>Start (s) <input type="number" min="0" max={analysis.duration} step="0.01" value={selectedNote.start.toFixed(2)} onChange={e => changeNote(selectedPart.id, selected!.index, { start: Math.max(0, Number(e.target.value)) })} /></label><label>End (s) <input type="number" min="0" max={analysis.duration} step="0.01" value={selectedNote.end.toFixed(2)} onChange={e => changeNote(selectedPart.id, selected!.index, { end: Math.max(0, Number(e.target.value)) })} /></label><label>Velocity <input type="number" min="1" max="127" value={selectedNote.velocity} onChange={e => changeNote(selectedPart.id, selected!.index, { velocity: Math.max(1, Math.min(127, Number(e.target.value))) })} /></label><button type="button" onClick={() => { changePart(selectedPart.id, { notes: selectedPart.notes.filter((_, i) => i !== selected!.index) }); setSelected(null) }}>Delete note</button></div></div>}
      </>}
    </section>
    <section className="panel"><h2>3. Export</h2><p className="muted">Export editable tracks to a standard MIDI file. For a closer sound, load it in a DAW and assign your preferred soundfont or virtual instruments.</p><button type="button" className="primary" disabled={!analysis} onClick={exportMidi}>Download multitrack MIDI</button></section>
  </>
}
