# Mac Model Catalog

## 1. Scope / Trigger

The daemon projects local model configuration into the mobile/Web catalog and
validates per-turn model overrides against the same source. Read the configured
picker list; fixed family aliases alone omit custom provider models.

## 2. Signatures

- `readModelCatalog(settingsPath?: string): Promise<ModelCatalog>`
- `isKnownModel(catalog: ModelCatalog, value: string): boolean`
- Authenticated `GET /api/models` returns `ModelCatalog`.
- New-session and existing-session message POSTs accept optional `model: string`.

## 3. Contracts

`ModelCatalog` is `{ models: ModelOption[], defaultModel?: string }`;
`ModelOption` contains only `{ id: string, alias: string, displayName: string }`.
The default settings path is `$CLAUDE_CONFIG_DIR/settings.json`, falling back to
`~/.claude/settings.json`. Each request re-reads the source.

For `modelPicker.options`, accept array entries with a valid trimmed `model`.
Use that value for both `id` and `alias`, preserving the existing client
`modelValue()` behavior. Use a non-empty trimmed string `label` for the display
name, otherwise derive it from the ID. Preserve first occurrence order and
remove duplicate full IDs. Provider prefixes are part of identity. Never spread
an option object into the response: descriptions can contain account information.

If any valid picker option exists, use picker rows instead of appending the four
legacy family rows. Resolve a default family alias through its valid configured
`env.ANTHROPIC_DEFAULT_*_MODEL` mapping. Include a valid default absent from the
picker. If there are no valid picker options, retain the legacy family catalog
and default behavior. Built-in aliases remain accepted as legacy POST inputs;
arbitrary concrete IDs must appear in the catalog.

Do not write Mac settings, probe upstream model providers, or invoke inference
just to build the catalog. Omitted model overrides remain omitted in SDK options.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Missing/malformed settings JSON | Legacy alias catalog; daemon stays available |
| Missing, non-array, empty, or wholly invalid picker | Legacy alias catalog |
| Invalid picker entry or model ID | Skip entry; preserve remaining valid options |
| Duplicate full ID | Keep first row |
| Missing, blank, or non-string label | Derive display name from ID |
| Invalid default model | Omit default |
| Unauthenticated GET/POST | `401 unauthorized` |
| Blank/non-string POST model | `400 invalid_model` |
| Unknown concrete POST model | `400 unknown_model` |
| Known model or compatible family alias | Pass model through to SDK |

Reuse the existing `modelId()` whitelist and length limit for every source of a
model identifier. Do not relax ID validation to accommodate picker labels.

## 5. Good / Base / Bad Cases

- Good: `provider-a/model` and `provider-b/model` appear as two separate options;
  selecting the latter sends that exact full ID.
- Base: settings without a picker still expose `fable`, `opus`, `sonnet`, `haiku`
  with their configured mappings.
- Bad: a picker entry with `model: "bad model"` is skipped; an unlisted concrete
  ID remains rejected even when submitted manually.

## 6. Tests Required

Reader regressions in `packages/daemon/__tests__/model-config.test.ts` must assert
picker completeness/order, full-ID deduplication, labels and safe projection,
default handling, invalid input fallback, and alias compatibility.

HTTP regressions in `packages/daemon/__tests__/server.test.ts` must use a temporary
settings fixture with the real reader and a fake SDK. Assert GET exposes picker
models, selected concrete IDs reach SDK options on both POST paths, unlisted
models remain rejected, and omitted overrides remain absent. Do not use personal
settings or paid inference in tests.

## 7. Wrong vs Correct

Wrong: enumerate only the four `ANTHROPIC_DEFAULT_*_MODEL` mappings, or copy each
picker entry wholesale into the response.

Correct: validate and project the configured picker options, using legacy alias
rows only when the picker has no valid options.

```typescript
{ id: validatedModel, alias: validatedModel, displayName: safeLabel }
```
