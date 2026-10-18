# Native iOS design refinement — 2026-09-26

## Request

Refine the existing frontend using the supplied dark Claude iPhone screenshot,
with native iOS adaptation and restrained Liquid Glass. Code exploration was
assigned to Luna at the user's explicit request.

## Scope and design

The current mobile client is `app/` (Expo SDK 57 / React Native), superseding the
older Capacitor implementation described in the original task artifacts.

- Charcoal dark palette, right-aligned user bubbles and full-width assistant text.
- Native system typography, 17pt / 28pt body text and 44pt minimum action targets.
- Shared circular navigation controls and a 28pt continuous-corner composer.
- `GlassSurface` uses `expo-glass-effect` only when both runtime availability
  checks pass and Reduce Transparency is off. Otherwise it uses themed solid
  colors. Content and disabled controls do not fade the glass parent.
- Existing keyboard-controller `automaticOffset` fixes are preserved. Insets
  remain inside the keyboard-avoiding container. Compact screens and larger
  Dynamic Type use two composer action rows.
- Existing model, permission, attachment, send, stop and transcript contracts
  remain unchanged. Reply sharing uses the iOS system share sheet.
- No backend edits, server deployment, user data mutation, or voice placeholders.

## Editable design

https://www.figma.com/design/ouoJs1IXbWEyoPIbBDDjBi

Chat: `1:2`; new chat: `1:3`; shared composer: `3:52`.
Includes semantic color variables, reusable control instances, project SVG brand
mark, SF Pro typography and glass effects. The official iOS library search was
available, but importing its components was denied by Figma; local components
were created instead. Both screens were visually checked after composition.

## Verification

- Project typecheck passed.
- Existing tests passed: 13 agent-bridge, 7 interactions, 82 daemon (102 total).
- CocoaPods synchronized ExpoGlassEffect 57.0.4 successfully.
- iOS Hermes bundle export passed. With this repository's existing Metro
  projectRoot configuration, set `NODE_PATH` to `app/node_modules` for the Expo
  CLI to locate React Native during Hermes compilation.
- Native simulator build reached app linking. ExpoGlassEffect Swift sources compiled,
  but the app failed to link missing React Native Debug symbols (including
  `Sealable`, `DebugStringConvertible`, and `RCTReconnectingWebSocket`). Runtime
  keyboard, Dynamic Type and glass appearance are therefore not yet verified.
  Build log: `/tmp/claude-remote-native-design-build.log`.
- Final source syntax check parsed all 34 native frontend modules successfully.

## Ownership

Existing unrelated edits to daemon/configuration/progress/Metro were preserved.
The two composers already contained uncommitted keyboard fixes; those fixes
remain in place. The older parent task includes broader acceptance criteria and
is not being archived by this UI refinement.
