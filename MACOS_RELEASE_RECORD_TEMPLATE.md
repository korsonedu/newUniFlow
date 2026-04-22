# UniFlow macOS Release Record

- Generated At: {{generatedAt}}
- Git Head: {{gitHead}}
- Product: {{productName}} {{version}}
- Rollout Lane `macos`: {{rolloutMacos}}
- Architecture: {{architectureSummary}}
- strictNativeMacOSUI: {{strictNativeMacOSUI}}

## Build Artifacts

- App Bundle: {{appBundle}}
- DMG Artifacts:
{{dmgArtifacts}}

## Toolchain

{{toolchain}}

## Reproducible Steps

{{reproducibleSteps}}

## Smoke Preflight

- Status: {{smokeStatus}}
- Smoke Report: {{smokeReportPath}}
- Manual Checklist:
{{manualChecklist}}
- Release Checklist: {{releaseChecklistPath}}

## Manual Acceptance Sign-off

- Status: {{manualAcceptanceStatus}}
- Summary: {{manualAcceptanceSummary}}
- Artifact: {{manualAcceptancePath}}
- [ ] App launches on macOS and the first project page renders correctly.
- [ ] A short recording creates timeline events and the playhead advances correctly.
- [ ] One structural edit keeps preview playback, waveform, and export state aligned.
- [ ] One export completes and matches the expected timeline fingerprint.
- [ ] External release wording does not claim AppKit/SwiftUI pure-native UI.

## Blocking Notes

- {{blockingNotes}}
