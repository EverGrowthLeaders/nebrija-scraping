# UI preview harness (dev tool, not shipped)

Renders the **real** `apps/web/public` SPA against a mocked API so you can see /
screenshot every screen without standing up Postgres + Redis + Google OAuth.

`mock-api.js` overrides `window.fetch` with representative data; `preview.html`
is `index.html` plus that mock; the shell scripts drive headless Chrome.

## Usage

```bash
# serve the repo root, then capture every route into scripts/ui-preview/shots/<tag>/
python3 -m http.server 8099 &
scripts/ui-preview/snap.sh after          # all routes
scripts/ui-preview/snap.sh after overview:/ leads:/leads   # specific routes
```

Or open `http://localhost:8099/scripts/ui-preview/preview.html#/leads` in a
browser to click around live.

Nothing here is referenced by the app — safe to delete.
