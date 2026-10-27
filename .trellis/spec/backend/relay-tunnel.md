# Relay Tunnel

> Contract between `packages/relay` (public relay server) and `packages/daemon/src/relay/connector.ts` (Mac side). Both import the single implementation in `@claude-remote/relay/protocol`; never fork frame parsing.

## Scenario: phone reaches the Mac daemon through a self-hosted relay

### 1. Scope / Trigger

- Any change to relay frames, flow control, agent auth, device identity, header forwarding, or which daemon routes are reachable via relay.
- Security boundary: the relay sees plaintext traffic but must never be able to obtain `BRIDGE_TOKEN` through the pairing endpoints.

### 2. Signatures

- Relay HTTP: `GET|HEAD /healthz` → `{ok:true, version}`; `* /d/<deviceId>/<path>` → tunnelled to the device; WS upgrade only for `/d/<deviceId>/ws`.
- Agent WS: `GET /agent` upgrade with `Authorization: Bearer <RELAY_SECRET>`, `X-Device-Id`, `X-Device-Key`.
- Protocol module: `encodeControl/parseControl/checkControl`, `encodeData/parseData`, `filterHeaders`, `deriveDeviceId/generateDeviceKey/isDeviceId/isDeviceKey`, `CreditSender/CreditReceiver`, `INITIAL_WINDOW = 256 KiB`.
- Daemon: `loadRelaySettings(env)`, `normalizeRelayUrl(raw)`, `relayBase({url, deviceId})` → `<url>/d/<deviceId>`; `GET /api/connect-info` → `{bases, relay}`.
- CLI: `cr relay add <url> <secret> | status | on | off | remove`.

### 3. Contracts

- Control frames are JSON text: `open{sid,kind:"http"|"ws",method?,path,headers,remote}`, `head{sid,status,headers}`, `accept{sid}`, `end{sid}`, `wsclose{sid,code,reason≤123B}`, `reset{sid,reason}`, `credit{sid,bytes≥1}`.
- Data frames are binary `[u8 type][u32 sid BE][payload]`; type `1` HTTP body, `2` WS text, `3` WS binary.
- `sid` is allocated by the relay only; an agent sending `open` is a protocol error (relay closes 1008).
- Flow control: each stream/direction starts with 256 KiB; receiver returns `credit` after consuming. Never send `credit` with `bytes: 0` (empty WS messages must not produce a credit frame).
- Device identity: `deviceId = base32lower(sha256("claude-remote-relay/v1:" + key))[:20]`; key is 43-char base64url. Relay re-derives on every `/agent` connect and stores nothing.
- Same deviceId reconnecting replaces the previous agent; old socket closed with `4001`. Connector backs off on 4001 with the auth-class cap (`authBackoffMaxMs`) so two Macs sharing one device key don't flap each other.
- Env (daemon `.env`, mode 0600, written via `editEnvFile`): `RELAY_URL`, `RELAY_SECRET` (≥32 printable ASCII, excluding `#` quotes backtick backslash — it is written unquoted and `process.loadEnvFile` would truncate it), `RELAY_DEVICE_ID`, `RELAY_DEVICE_KEY`, `RELAY_ENABLED=on|off`. Relay server: `RELAY_SECRET`, `RELAY_HOST`, `RELAY_PORT` (8790), `RELAY_MAX_BODY_MB` (25, matches daemon upload limit).

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `/agent` bad/missing Bearer | 401 `unauthorized` |
| malformed id/key | 400 `invalid_device` |
| key does not derive id | 403 `device_key_mismatch` |
| device not connected | 503 `device_offline` |
| streams ≥ `maxStreams` | 503 `too_many_streams` |
| Content-Length > max body | 413 `body_too_large` |
| no `head`/`accept` in time | 504 `upstream_timeout`; HTTP idle → 504 `idle_timeout` |
| agent drops mid-stream | 502 `device_disconnected`; agent `reset` → 502 `upstream_reset`; bad frame → 502 `upstream_protocol_error` |
| HTTP `open` for `/api/pair-info` or `/api/pair-qr.svg` (after WHATWG normalization) | connector answers 403 `loopback_only`, never reaches daemon |
| `RELAY_URL` not https (http only for localhost/127.0.0.1), or has query/credentials | `ConfigError` |

### 5. Good/Base/Bad Cases

- Good: phone `GET /d/<id>/api/sessions` with Bearer → connector replays to `127.0.0.1:<port>` with `X-Forwarded-For/Proto/Host` → daemon validates token.
- Base: daemon offline → relay 503 immediately; phone falls back to other bases.
- Bad: `/d/<id>/api/%2e/pair-info` or `/d/<id>/api//pair-info` → still 403 (path normalized the same way the daemon routes it; daemon's `looksProxied()` is the second layer).

### 6. Tests Required

- `packages/relay/__tests__/relay.test.ts`: auth matrix, replacement → 4001, body limit 413, credit window backpressure, empty WS message delivered with no `bytes:0` credit (FakeAgent throws on invalid frames).
- `packages/daemon/__tests__/relay-connector.test.ts`: pairing variants all 403 and never hit daemon; forwarded headers present and `host` rewritten; reconnect backoff; 4001 handling; no secrets in logs.
- `packages/daemon/__tests__/relay-config.test.ts`: URL normalization and id/key mismatch rejection.

### 7. Wrong vs Correct

#### Wrong

```ts
if (open.path === "/api/pair-info") return reject(); // raw string compare, bypassed by %2e, //, ./
```

#### Correct

```ts
if (open.kind === "http" && PAIR_PATHS.has(new URL(open.path, "http://local").pathname)) return this.#rejectPair(link, open.sid);
// and always add X-Forwarded-* so daemon's looksProxied() rejects pairing even if this check is bypassed
```

## Gotchas

> **Warning**: Do not trust "came from 127.0.0.1" for anything new. Relay traffic is replayed from loopback; only the pairing routes use loopback gating, and they rely on `looksProxied()` as defence in depth. New loopback-only routes must be added to `PAIR_PATHS` too.

> **Warning**: Never use `git stash` in this repo for scratch work — the stash list is shared across worktrees and `pop` can apply another branch's stash.
