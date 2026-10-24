# Song to MIDI Studio

A FreeAppStore browser app for capturing tab audio or opening a local recording, estimating musical events, editing the result, and exporting a multitrack Standard MIDI File.

## What works

- Browser tab audio capture through `getDisplayMedia` and `MediaRecorder`, with an audio-file fallback.
- Local decode and analysis of recordings up to three minutes. No recording upload or server storage.
- FFT harmonic salience with subharmonic suppression for bass, lead, and harmony note candidates; broad-band energy changes for kick/snare/hat candidates. Detected onset timing is preserved rather than forcing a beat grid.
- Approximate tempo, confidence, piano-roll review, note start/end/pitch/velocity edits, mute/solo, and General MIDI program selection.
- A/B playback of the original and a simple oscillator sketch, and Type 1 multitrack `.mid` export with a tempo map and percussion channel.

## Limits

This is a signal-processing MIDI sketch. It does **not** isolate audio stems, identify actual instrument makes/models, or faithfully reproduce a dense studio mix. Vocals, reverb, distortion and overlapping pitches can confuse it. The in-app oscillator preview is much simpler than a soundfont or DAW instrument. Review and correct the notes and choose a quality General MIDI soundfont after export.

No external model or third-party sample library is used. A future higher-fidelity version would need licensed source-separation and polyphonic transcription models, substantial client compute or a consent-based processing backend, plus timbre-matched soundfont selection.
