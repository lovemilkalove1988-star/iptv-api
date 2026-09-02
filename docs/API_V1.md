# MILK TV API v1

`MILKTV_API_VERSION=v1`. All new responses use `{ "ok": true, "data": ... }`; errors use `{ "ok": false, "error": "CODE", "message": "..." }`.

## Public discovery

- `GET /api/v1/health` returns `status` and `api_version`.
- `GET /api/v1/capabilities` returns the safe client feature list.

## Authentication and devices

- `POST /api/v1/client/login` accepts `login`, `password`, `device_id`, and optional `device_name`. It establishes the existing cookie session and registers (or refreshes) that device.
- `GET /api/v1/client/session` validates the session/device and returns the client profile, device limit, and CSRF token.
- `POST /api/v1/client/logout` requires the device header and `X-CSRF-Token`.
- All client routes after login require the session cookie and `X-MILKTV-DEVICE` matching a registered device. Inactive/expired clients receive `ACCESS_DENIED`; absent/invalid session or device receives `UNAUTHORIZED`.
- A client may have at most **4** devices. A fifth distinct device receives HTTP 409 `DEVICE_LIMIT_REACHED`; the server never removes a device automatically.
- `GET /api/v1/client/profile` and `GET /api/v1/client/devices` expose only client-safe fields.

## Channels and playback

- `GET /api/v1/client/channels` returns logical slot identities with `id`, `name`, `logo`, `category`, `available`, and `current_source_health` (`online`, `offline`, or `unknown`). It does not expose internal sources or diagnostics.
- `GET /api/v1/client/channels/:channelId/play` returns only the current server-selected `playback_url`, `channel_id`, `expires_at` (currently `null`), and `health_status`. Clients must not select alternates.
- Legacy `GET /playlist/:token.m3u` remains unchanged for SS IPTV/IPTV Pro compatibility.

## EPG and reminders

- `GET /api/v1/client/epg/now-next?channel_ids=1,2` returns a deterministic entry per requested channel: `{ channel_id, now, next }`. Programme fields are `title`, `start`, `stop`, and `progress`; absent EPG is `null`.
- `GET /api/v1/client/reminders`, `POST /api/v1/client/reminders`, and `DELETE /api/v1/client/reminders/:id` reuse the existing reminder records. Delivery state remains device-specific in the existing delivery table.

## Preferences

- `GET /api/v1/client/preferences`
- `PUT /api/v1/client/preferences/:channelId` accepts `favorite`, `hidden`, and `custom_name`.

State-changing client requests require the CSRF token returned by login/session in `X-CSRF-Token`.

## Stable errors

Common codes: `UNAUTHORIZED`, `ACCESS_DENIED`, `DEVICE_LIMIT_REACHED`, `DEVICE_OWNED_BY_OTHER_CLIENT`, `CSRF_REQUIRED`, `INVALID_REQUEST`, `CHANNEL_NOT_FOUND`, `PLAYBACK_UNAVAILABLE`, `PROGRAMME_UNAVAILABLE`, and `REMINDER_NOT_FOUND`.
