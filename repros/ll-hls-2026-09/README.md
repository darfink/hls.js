# LL-HLS regression reproductions

Baseline: upstream master `c721313f028431b107e4a77edf40bb908f8d782c`, fetched 2026-09-24.
The page labels the exact baseline rather than silently changing it as master advances.
Build identities and served SHA-256 hashes are in [provenance.json](provenance.json).

## State reproductions

Open `index.html` over HTTP, choose a scenario and build, then select **Run selected case**.
The first four scenarios use the real player controllers and parser, with an explicit prior-state setup.
They are reductions of the source regression tests, not end-to-end demonstrations.
Each fails on the baseline and passes with only its corresponding patch.

- Tail: the baseline selects part 5 instead of pending part 4 at the exact boundary.
- Subtitle delta: the baseline raises null-placeholder exceptions and cannot restore the cached playlist.
- Tracker: the baseline reports OK after a parent's advertised duration grows past its buffered tail.
- ENDLIST: the baseline selects no fragment while the last advertised part remains unloaded.

The excerpts contain illustrative relative media names and are intended for parsing and review.
Use the separate captured assets for playable media.

## Actual playback

The playback case replays captured playlist snapshots through a custom hls.js loader.
Media requests fetch real static fMP4 files. Audio and video switches use the normal player APIs.
The loader reproduces a playlist evolving over time; it is not a general LL-HLS blocking-reload server.
The fixture was generated without publisher loss. I-frame-only playlist entries are omitted because this capture covers normal audio/video playback. Allow 40 seconds per run.

The static [master playlist](assets/media/index.m3u8) is an ordinary ended presentation.
It can be opened in another player as a media sanity check, but does not reproduce live update races.
The combined build includes all four patches. Its playback result does not isolate each patch's contribution.

## Local reproduction

```sh
python3 -m http.server 8769 --bind 127.0.0.1
# Start a compatible ChromeDriver on port 4448, then:
python3 tools/verify.py http://127.0.0.1:8769/
```

Capture the synthetic fixture again from the Rushls checkout:

```sh
python3 tools/capture.py --repo /path/to/rushls --output /tmp/hls-fixture
```

Copy `media/` and `snapshots.json` from that output into `assets/`.
The capture uses FFmpeg and Rushls's ignored live-origin test; it does not record user media.
Build the player modules from each recorded source commit using upstream's lockfile and `rollup --config --configType fullEsm`.
The hosted files omit only the final source-map URL because those maps are not hosted.

## Scope

A controller regression establishes a specific incorrect decision, not proof that every user encounters it.
Playback outcomes can vary with buffering and browser timing. These fixes do not claim perfect GAP concealment or resolve all repeated audio appends.
Local verification: all four state regressions fail on the baseline and pass with their isolated fixes.
The recorded playback case stalls before ENDLIST on the baseline and ends at 24.021333 seconds with the combined build.
Exact observed results are in [verification.json](verification.json).
Portable source patches against the pinned base are in [patches/](patches/).

No production media, credentials, analytics, or external player CDN are used.
Player code retains its Apache-2.0 license.
