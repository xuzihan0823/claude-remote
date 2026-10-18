# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)

## Native iOS surfaces (`app/`)

- Use `useTheme()` semantic colors and React Native system text for native chat
  UI. Keep assistant prose on the screen background and user text in a trailing
  bubble. Tool/thinking blocks remain independently expandable.
- `GlassSurface({ children, style, interactive })` owns Liquid Glass capability
  checks and the Reduce Transparency subscription. Do not apply animated opacity
  to the glass or its parents; disabled appearance belongs to individual controls.
- Use the shared SVG `Icon` for controls and `Spark` for branding. Actions must
  have a label, button role, and at least a 44pt touch area.
- `ComposerActions` uses two rows below 360pt or above font scale 1.3. Long model
  names may truncate visually but retain their full accessibility label.
- Keep composer bottom safe-area padding inside `KeyboardAvoidingView` and
  preserve `automaticOffset` with `keyboardVerticalOffset={-padBottom}`. The
  keyboard controller owns its animated padding; parent padding is not a safe
  substitute.
- Expo SDK 57 native modules require CocoaPods sync and a native rebuild.
  `NODE_PATH="$PWD/node_modules" npx expo export --platform ios` from `app/`
  validates the Hermes bundle with the repository's monorepo Metro root. Set
  `NODE_PATH` to `app/node_modules`, where React Native is installed, rather than
  the repository root's `node_modules`.
