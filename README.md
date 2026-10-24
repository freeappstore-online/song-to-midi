# Song to MIDI Studio

A FreeAppStore browser app for capturing tab audio or opening a local recording, estimating musical events, editing the result, and exporting a multitrack Standard MIDI File.

## What works

- Browser tab audio capture through `getDisplayMedia` and `MediaRecorder`, with an audio-file fallback.
- Live recording timer, progress bar, captured size and input-level meter.
- Automatic local saving of tab recordings in IndexedDB, with an in-app library to reopen, download or delete them after a reload.
- Local decode and analysis of recordings up to three minutes. No recording upload or server storage.
- **Fast mode:** FFT harmonic salience for bass, lead and harmony candidates, plus transient estimates for kick, snare and hi-hat.
- **AI note mode:** Spotify Basic Pitch runs locally on the full mix to transcribe polyphonic pitched notes. The app groups these by pitch and overlap into approximate bass, lead and harmony MIDI tracks; drum and tempo estimates come from transient analysis.
- Piano-roll review, note start/end/pitch/velocity edits, mute/solo, General MIDI program selection, original/MIDI preview and Type 1 multitrack `.mid` export.

## Limits

Neither mode isolates audio stems or identifies specific instruments reliably. Dense mixes, vocals, effects and overlapping pitches can confuse transcription. The in-app oscillator preview is simpler than a soundfont or DAW instrument. Review the notes and choose good virtual instruments after export.

AI note mode uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch-ts) (Apache 2.0). The model is loaded from jsDelivr and inference runs in the browser; recordings are not uploaded. Performance varies by device and song length.

Saved recordings remain in this browser profile on this device. Clearing site data or private browsing may remove them. Analysis results and note edits are not persisted; export MIDI to keep those.
