// apps/desktop/electron/services/remotion-binaries-message.ts
//
// ONE SENTENCE, IN A MODULE THAT IMPORTS NOTHING.
//
// Four code paths need ffmpeg — Design MP4 export (both engines), RIFE frame
// interpolation, and last-frame extraction — and all four must say the same
// thing when the encoder has not been fetched yet. The obvious home for the
// sentence is the installer that owns the feature, and that is where it lived
// for about ten minutes.
//
// It could not stay there. `rife-runner.ts` is covered by a structural test
// (test/unit/rifeWiring.test.ts, "the run path CANNOT reach the network") that
// walks static imports transitively and fails if any of them reaches http/https.
// Importing the installer pulled in installer-kit, which pulls in `https`, and
// the guarantee that a RIFE run cannot phone home stopped being structural.
// The test caught it immediately, which is the whole reason it exists.
//
// So the string lives on its own, with no imports at all, and every consumer —
// including the one that must never touch the network — can read it.

/**
 * What to tell a user whose render needs an encoder that is not installed.
 *
 * Says what to DO first, then what it costs, then why it is a download rather
 * than part of the app. The previous text was "reinstall dependencies", which is
 * advice nobody running a packaged build can act on.
 */
export const REMOTION_BINARIES_MISSING =
  'Video export needs the encoder, which is not installed yet. It is a one-time ~47 MB download from Remotion\'s official npm package — open Design → Export and choose "Install video encoder". It is fetched separately rather than bundled because its FFmpeg build states its own licence forbids redistribution.'
