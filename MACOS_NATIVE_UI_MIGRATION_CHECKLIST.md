# UniFlow macOS Native UI Migration Checklist

## Goal

- Target state: AppKit or SwiftUI macOS UI on top of the existing Rust native core and event-sourced timeline model.
- Current state: Tauri desktop shell with React/Vite WebView UI. This is not yet pure-native macOS UI.

## Can Reuse Directly

- `src-tauri/src/native_core/*`: Rust timeline core, command bridge payloads, native time helpers.
- `src/application/clock/*`: unified clock logic and drift correction rules.
- `src/application/timeline/transactions.ts`: structural edit transaction model and command semantics.
- `src/application/export/*`: export consistency assertions, normalization, and background job policy.

## Bridge Layer To Replace Or Re-home

- `src/infrastructure/platform/dialog.ts`: replace DOM file picker fallback with `NSOpenPanel` or SwiftUI `fileImporter`.
- `src/infrastructure/platform/fileSave.ts`: replace anchor-download path with `NSSavePanel` or native document export flow.
- `src/infrastructure/platform/frameScheduler.ts`: replace `requestAnimationFrame` dependency with native display-link scheduling.
- `src/store/persistence.ts` and `src/store/snapshot.ts`: replace `window.localStorage` persistence with app support storage or document-based state.

## React or WebView Bound UI That Must Be Rewritten

- `src/App.tsx`: project shell, local project list, export menu, page manager, and keyboard window hooks.
- `src/components/canvas/WhiteboardCanvas.tsx`: SVG/canvas interaction layer, touch and wheel gestures, page preview overlays.
- `src/components/canvas/ToolWorkbench.tsx`: toolbar presentation and secondary popover UI.
- `src/components/timeline/TimelineEditor.tsx`: recording flow, context menu, selection state, keyboard handling.
- `src/components/timeline/TimelineTrack.tsx`: scroll viewport, drag preview, resize observer logic.
- `src/components/timeline/OperationBar.tsx`, `ReplayControls.tsx`, `src/components/recording/RecordingOverlay.tsx`, `src/components/ui/CupertinoSwitch.tsx`: controls that currently depend on React state and DOM rendering.

## Migration Order

1. Extract a UI-agnostic presentation model for project list, operation state, and timeline selection from `src/App.tsx` and the current Zustand store.
2. Replace file open/save, persistence, and scheduler adapters with native macOS implementations while keeping the event-sourced core unchanged.
3. Rebuild the operation bar, tool workbench, and recording overlay in native macOS UI.
4. Rebuild the timeline track/editor and whiteboard canvas with native rendering and gesture handling.
5. Remove WebView-only fallbacks after AppKit/SwiftUI parity is reached and smoke/export regressions stay green.

## Exit Criteria

- macOS UI launches without WebView-hosted React screens.
- Structural edits, playback, waveform activity, and export fingerprint parity remain unchanged.
- Release reports can set `strictNativeMacOSUI=true` without qualification.
