# VoicePad

**A local audio pad made for Audio-Technica ATV-SG1 `+EXT` recordings, and useful with other dual-channel video.**
In `+EXT` mode, the ATV-SG1 records its built-in shotgun mic on the **left** channel and an external
lavalier mic on the **right**. The shotgun can capture more natural space and detail; the lavalier
keeps a consistent voice level as the camera distance changes. Record both, then choose the balance
for each scene afterward. That is why VoicePad exists.
[简体中文](README.md) · [Official ATV-SG1 user manual](https://docs.audio-technica.com/eu/ATV-SG1-UM-EN.pdf)

VoicePad is a local web app inspired by a two-dimensional color pad. Move **left or right** to blend
the two input channels into one mono track. Move **up or down** to make the voice brighter or warmer;
use the slider above for overall level. Auto-align the channels, save settings per clip, and export
a batch while copying the original video stream without re-encoding it. There are no npm dependencies:
the server uses Node.js built-ins and invokes ffmpeg/ffprobe. VoicePad is an independent creator tool
and is not affiliated with Audio-Technica.

> The ATV-SG1's `SAFE` mode is different from `+EXT`: its right channel is a lower-level backup of
> the same mic, not a separate lavalier recording. VoicePad can still select either channel.

## Origin

After bringing an ATV-SG1 home from Japan, the creator was drawn to its ability to turn the
“lavalier or shotgun?” decision into “record both.” A lavalier is a dependable track when distance
changes; a shotgun needs no mic on each person and can preserve more natural detail. Each may work
better in a different scene. VoicePad moves that choice to the edit: align the tracks, then drag
the pad to find the blend and tone that fit the shot.

## Quick start: Windows and macOS

1. Install [Node.js 22+](https://nodejs.org/en/download) and
   [ffmpeg/ffprobe](https://ffmpeg.org/download.html). On Windows, follow “Windows EXE Files” from
   the FFmpeg download page and add the extracted `bin` folder to `PATH`. Open a new terminal and
   verify `node --version`, `ffmpeg -version`, and `ffprobe -version`.
2. Open PowerShell (Windows) or Terminal (macOS) in this repository and run `node server.js`.
3. Open <http://localhost:5178> in a browser. Drop in videos or paste a folder path.

The server listens only on `127.0.0.1`. All processing stays on your computer. Dragged files are
copied to a **local** temporary directory when alignment or export needs server access; folder-path
mode reads the originals directly. Nothing is uploaded to a cloud service.

The Windows web version has not been tested on a Windows machine yet. Edge or Chrome is recommended;
please open an issue if you encounter a compatibility problem.

### macOS app

On macOS, `./macos/build-app.sh` builds a self-contained `VoicePad.app` in the repository folder,
using the Node.js and ffmpeg binaries installed on that Mac. The generated app is ignored by Git.
Building requires Apple's Swift command-line tools. A build intended for distribution to other Macs
would also need architecture checks, code signing, and notarization.

## Why two microphones?

A lavalier track is reassuring when the subject moves away from the camera. A shotgun track can
retain more texture and works when you turn the camera toward another person without attaching a
mic to them. With the ATV-SG1 in `+EXT` mode you can keep both tracks in one camera recording.
VoicePad lets you use just the lavalier, just the shotgun, or a mixture that suits the shot, then
adjust the tone in seconds. It also works with other recordings that put two useful sources on
separate left and right channels.

The horizontal control is a **blend**, not stereo panning: the output is mono. It uses equal-power
cosine/sine weights, which keep the level more consistent when the two sources are unrelated.
Highly correlated sources can still sound louder near the center, so listen before committing.
The “Stereo monitor” button lets you hear the untouched input channels; it does not affect export.

## Workflow

| Import method | How | Export location | Extra local copy |
| --- | --- | --- | --- |
| Drop or choose files | Drag files or a folder into the page, or use “Choose files” | `Movies/VoicePad` on macOS; `Videos/VoicePad` on Windows | Yes, when aligning or exporting |
| Folder path | Paste an absolute path into the header field | Next to each source, with a `_voicepad` suffix | No |

Browsers do not expose the absolute path of a dropped file, which is why the first mode transfers
its bytes to the local server. Both modes preserve the original file. If an output name is taken,
VoicePad appends `_1`, `_2`, and so on. The app excludes its own exports when scanning a folder.

Each clip keeps its own tone, blend, level, and alignment values. Copy a setting with `Ctrl/⌘C`,
select other clips, and apply it with `Ctrl/⌘V`; you can still fine-tune clips individually. Use
arrow keys to adjust the pad, Shift for finer steps, and Space to play or pause. The playback bar
supports seeking and dragging.

### Channel alignment

Two microphones recording the same speaker may be offset by a few milliseconds. Blending them
without alignment can cause comb filtering. VoicePad can estimate the offset and move one channel
before mixing; a manual slider is available too. In folder mode it can automatically align the
batch on import. When the channels do not appear to contain the same source, it leaves them alone.

### Preview and export

`public/dsp.js` is the shared source of filter coefficients. The browser uses Web Audio biquads for
live preview; export passes the same coefficients explicitly to ffmpeg's `biquad` filters. The
export chain resamples audio to 48 kHz **before** applying those coefficients and sample-based
alignment. Mono inputs are duplicated to both input channels before blending.

Export copies the video stream (`-c:v copy`) and encodes the new mono audio as AAC at 256 kb/s.
Source video is not overwritten. This tool changes channel balance and voice tone; it is not a
noise-removal or source-separation system. Container and codec combinations vary, so verify a
short export before processing a large batch.

## Requirements

- Node.js 22+ and ffmpeg/ffprobe available on `PATH`
- A current Chromium browser (Edge/Chrome on Windows) or Safari on macOS
- Enough writable disk space for the local temporary copy when importing by drag and drop

## License

See [LICENSE](LICENSE).
