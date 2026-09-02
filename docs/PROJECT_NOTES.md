# MILK TV permanent requirements

## Public MILK TV access (immutable)

The public MILK TV view must always be available at `/client/channels`:

- authenticated users may open it;
- unauthenticated users may open it;
- no client session or login is required for the public viewing screen;
- `/client/channels` must not redirect to `/client/login`.

This requirement applies even when authentication, session, middleware, route, security, or client-page code changes are made.

Public viewing must remain limited to the public-safe channel/playback/EPG contract. It must never expose raw stream URLs, admin APIs, diagnostics, source/reserve data, candidate data, quarantine internals, trust/promo internals, or client-private data. Personal client features and all admin functions may remain protected and should request login only when the user invokes them.

## Mandatory authentication regression check

After any change to authentication, sessions, middleware, routes, the client page, MILK TV, security, or redirects, verify all of the following:

1. Open the authorization page without a session.
2. Activate the MILK TV button/link.
3. Confirm that it opens `/client/channels`.
4. Confirm there is no redirect back to `/client/login`.
5. Confirm the public channel list loads.
6. Confirm protected admin endpoints still reject unauthenticated requests.
7. Confirm public responses contain no raw stream URLs or admin data.

Acceptance criteria:

```
UNAUTHENTICATED MILK TV: PASS
AUTHENTICATED MILK TV: PASS
UNAUTHENTICATED ADMIN API: BLOCKED
PUBLIC RAW STREAM URL EXPOSURE: NO
```
