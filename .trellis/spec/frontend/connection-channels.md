# Connection Channels

> How the mobile client (shared `web/core/*` + `app/`) picks among a device's addresses (Tailscale, LAN, mDNS, relay) and recovers when one dies.

## Scenario: one device, several bases

### 1. Scope / Trigger

- Any change to probing, `devices.js` base storage, WS heartbeat/reconnect, or the device settings channel UI.

### 2. Signatures

- `web/core/api.js`: `probeBase(base, tok, opts)`, `probeBases(bases, tok, opts)`, `isRelayBase(base)`, `PROBE_TIMEOUT_MS = 8000`, `DIRECT_GRACE_MS = 1500`.
- `web/core/devices.js`: `baseChannel(base)` → `tailscale|lan|mdns|relay`, `channelPrefOf(d)`, `CHANNEL_PREFS = ['auto','direct','relay']`, `candidateBases(d)`, `syncBases(id, daemonBases, connectedBase?)`, `upsertDevice({manual})`, `updateDevice(id, {bases, channelPref, token, ...})`.
- `web/core/ws.js`: `createWs(...)`, `setAutoReselect(on)`, `resume()`, `WS_PING_MS = 10000`, `WS_PONG_TIMEOUT_MS = 5000`, bus event `ws-reselect`.
- `app/src/App.js`: `reselect()` exposed via conn context; called on foreground and on `ws-reselect`.

### 3. Contracts

- Device record: `bases[]`, `manualBases[]` (user-entered, never pruned by sync), `lastBase`, `channelPref` (default `auto`), `token`.
- Relay base shape: `https://<relay>/d/<deviceId>` (`isRelayBase` matches a path ending in `/d/<id>`, so relay URLs with a path prefix still count as relay).
- `GET /api/connect-info` (Bearer) → `{bases: string[], relay: RelayStatus}` (`{state:"disabled"}` when relay is off; `base` present once configured); client calls `syncBases` after connecting so new channels (e.g. a newly added relay) reach already-paired phones.
- WS app-level ping: client sends `{type:"ping"}`, daemon answers `{type:"pong"}` before any session check.

### 4. Validation & Error Matrix

| Condition | Behaviour |
|---|---|
| a direct base answers first | use it immediately, abort others |
| relay answers first | wait up to `DIRECT_GRACE_MS` for a direct base, then use relay |
| any base returns 401 | stop and surface auth error (token wrong everywhere) |
| all fail | throw last error (`network_timeout` text mentions Tailscale or relay) |
| `channelPref=direct` / `relay` | `candidateBases` filters to that class only |
| an open WS closes unexpectedly, 2 consecutive connect failures, or one half-open (no frame within 5 s of a ping, once a pong was seen) | emit `ws-reselect`, pause retries until App reselects |

### 5. Good/Base/Bad Cases

- Good: at home on Wi-Fi, LAN and relay both answer → LAN wins.
- Base: away from home with no Tailscale → direct probes time out, relay used; on returning home, foreground `reselect()` moves back to direct.
- Bad: pruning `manualBases` in `syncBases` — user-entered addresses disappear after every connect.

### 6. Tests Required

- `web/core/probe.test.js`: direct-first, relay grace window, 401 short-circuit, abort of losers (inject fake timers/fetch).
- `web/core/ws.test.js`: ping cadence, half-open only after first pong, `ws-reselect` after 2 failures.
- `web/core/devices.test.js`: `syncBases` keeps manual bases + connected base, clears stale `lastBase`; `candidateBases` filtering per pref.

### 7. Wrong vs Correct

#### Wrong

```js
for (const b of bases) { try { return await probeBase(b, tok); } catch {} } // serial: a dead Tailscale IP costs 8 s before relay is tried
```

#### Correct

```js
const base = await probeBases(candidateBases(device), tok); // parallel, direct preferred within the grace window
```
