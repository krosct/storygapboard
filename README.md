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

- **Local:** Python 3.10+ (with `venv`) and Node.js 20.19+ / 22.12+ with npm.
- **Server:** nothing to install or prepare by hand. Basic Linux tools (`tar`, `curl` or `wget`) and an
  SSH user are enough: GitHub Actions ships a ready release (built frontend included), and `deploy.sh`
  brings its own Python (via a pinned, checksum-verified `uv`). No git, Node or Python packages needed.

## Run locally

```bash
./deploy.sh local          # http://localhost:8080 — Ctrl+C stops it
```

If Caddy is installed it is used in front of the app, as in production.

## Deploy (GitHub Actions → server that already runs other apps behind Caddy)

Every push to `main` that passes the checks (or a manual "Run workflow") builds a release package of exactly
that commit and sends it with `deploy.sh` over SSH. On the server the script, on its own:

- creates the project folder (`DEPLOY_PATH`; with passwordless sudo also outside the user's home);
- unpacks the release into `releases/<commit>/` and switches `current` to it, **rolling back to the previous
  release automatically** if the new one fails its health check;
- installs its own Python 3.12 and the backend dependencies inside the project folder;
- writes `.env` from the `DEPLOY_<KEY>` GitHub secrets/variables (validated; updated when they change);
- keeps the app running as a user systemd service (enabling linger itself, or via sudo) or, if that is not
  possible, with a cron watchdog that restarts it;
- publishes the site in the existing Caddy: via the Caddyfile `import` if it is already there, by adding that
  one line itself when it has passwordless sudo (backup + validation + rollback), or otherwise through Caddy's
  local admin API, re-applied automatically every minute if Caddy reloads.

It never touches other apps: only its own folder, its own user service/timer or tagged crontab lines, and the
single import line described above. Helpers on the server: `<DEPLOY_PATH>/current/deploy.sh production
status|logs|restart|stop`.

GitHub setup: repository variable `DEPLOY_ENABLED=true`; environment `vars` with the secrets `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_PATH` (optional `DEPLOY_PORT`) and the app
settings as `DEPLOY_<KEY>` secrets or variables (at least `DEPLOY_SITE_ADDRESS`). See `.env.example` for
the keys.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m unittest discover -s tests -t .   # tests
../.venv/bin/uvicorn app.main:app --reload                              # API on :8000
cd ../frontend && npm install && npm run dev                            # UI on :5173
```

## Credits

Design: [Dimension by HTML5 UP](https://html5up.net) (CCA 3.0, see `LICENSE.txt`). Icons: Font Awesome Free.
