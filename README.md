# StoryGapBoard

Turn a short story — plus optional notes and reference images — into an AI-generated storyboard (one image
with a grid of panels: 1x3, 1x6, 2x1, 2x2, 2x3, 3x1 or 3x2, rows x columns), using any image model on
[OpenRouter](https://openrouter.ai). Visitors bring their own OpenRouter API key.

- **Generate**: story prompt, aspect ratio, layout, size, format and seed; one storyboard image per generation, downloaded
  straight to the browser's default download folder.
- **Files**: up to 5 files (5 MB each). `.txt`/`.md` become prompt context; PNG/JPEG/WebP/GIF are sent
  as visual references.
- **Model**: any OpenRouter image model; the API key lives only in the open tab.

## Privacy and abuse protection

- The API key is kept in the tab's memory only (gone when the tab closes), sent in a request header,
  never stored or logged. Uploaded files and generated images are processed in memory, never saved.
- The server keeps a CSV generation log (prompt, settings, cost, salted hashes of the client IP and
  key). It is never exposed over HTTP.
- Per-client limits on API calls and generations, one running generation per client, a global
  concurrency cap, a temporary lock after repeated rejected keys, body size caps, strict security
  headers (CSP, frame denial, no referrer) and no API docs endpoint.

## Requirements

Python 3.10+ (with `venv`) and Node.js 20.19+ / 22.12+ with npm. In production also git, systemd and an
existing Caddy. No Docker. `deploy.sh` checks all of this and never installs system packages.

## Run locally (same build and server command as production)

```bash
./deploy.sh local          # http://localhost:8080 — Ctrl+C stops it
```

If Caddy is installed it is used in front of the app, as in production.

## Deploy on a server that already runs other apps behind Caddy

The app runs natively as a **user** systemd service listening on `127.0.0.1` only. The deploy only touches
this project folder and its own unit file (`~/.config/systemd/user/storygapboard.service`); it never edits
your main Caddyfile and reloads Caddy only when this app's site block changes.

```bash
sudo mkdir -p /srv/storygapboard && sudo chown deploy: /srv/storygapboard   # once, as an admin
sudo loginctl enable-linger deploy                                            # once: keep the service after logout
git clone <this repository> /srv/storygapboard && cd /srv/storygapboard        # as the deploy user
cp .env.example .env       # set SITE_ADDRESS (and APP_PORT if 8787 is taken)
./deploy.sh production     # first run prints the one line to add to your Caddyfile:
#   import /srv/storygapboard/storygapboard.caddy
./deploy.sh production     # run again after adding it: Caddy picks up the site
```

Other commands: `./deploy.sh production status|logs|stop|restart`. Each run updates the checkout
(fast-forward only), dependencies and the build. Pushes to `main` can deploy automatically through GitHub
Actions; see `.github/workflows/ci-cd.yml`. The CI job sends `deploy.sh` over SSH, so the folder in
`DEPLOY_PATH` is created and cloned if it does not exist yet (with the optional `DEPLOY_SITE_ADDRESS` secret
it also writes `.env` on the first deploy and keeps its `SITE_ADDRESS` in sync with the secret).

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m unittest discover -s tests -t .   # tests
../.venv/bin/uvicorn app.main:app --reload                              # API on :8000
cd ../frontend && npm install && npm run dev                            # UI on :5173
```

## Credits

Design: [Dimension by HTML5 UP](https://html5up.net) (CCA 3.0, see `LICENSE.txt`). Icons: Font Awesome Free.
