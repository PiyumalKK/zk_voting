# IdentityHub (mock)

A tiny stand-in for a real government identity-management system, for testing
zk_voting's bulk-import "Identity-management API" option. No auth, no real
database, no dependencies — Node's built-in `http` module and one seeded JS
file (`data.js`) holding everything in memory.

## Run it

```
node server.js
```

(or `npm start` — nothing to install first)

Defaults to port 4500. Override with `PORT=5000 node server.js`.

## Pages

1. **Database** (`/`) — read-only view of every division, GN officer and
   voter on record. Pre-seeded, fixed data — not something you generate here.
2. **API Configuration** (`/api.html`) — pick which divisions are in scope.
   Only officers and voters belonging to a selected division become
   selectable; everyone else is shown but disabled. Click **Apply
   configuration** to publish that exact selection.

Until something has been applied, all three API endpoints return `[]` — "not
configured" means "nothing to import," not a fabricated default.

## Endpoints (what zk_voting's bulk import pulls from)

| Method | Path                | Shape                       |
| ------ | ------------------- | --------------------------- |
| GET    | `/api/divisions`     | `[{ name }]`                |
| GET    | `/api/gn-officers`   | `[{ username, division }]`  |
| GET    | `/api/voters`        | `[{ nic, phone, division }]`|

No authentication — leave the API key field blank in zk_voting's admin bulk-
import panel when pointing it at one of these.

Restarting the server resets the published scope to empty (the underlying
database stays the same, seeded from `data.js`) — re-apply a configuration
from the API Configuration page after a restart.
