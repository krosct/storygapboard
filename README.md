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

## Run locally (same stack as production)

Requires Docker with the compose plugin.

```bash
./deploy.sh local          # http://localhost:8080
./deploy.sh local down     # stop
```

## Deploy

On a server with Docker and a domain pointing at it:

```bash
git clone <this repository> storygapboard && cd storygapboard
cp .env.example .env       # set SITE_ADDRESS to your domain
./deploy.sh production     # builds, starts app + Caddy (automatic HTTPS)
```

`./deploy.sh production` also updates the checkout (fast-forward only) before building. Pushes to
`main` can deploy automatically through GitHub Actions; see `.github/workflows/ci-cd.yml`.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m unittest discover -s tests -t .   # tests
../.venv/bin/uvicorn app.main:app --reload                              # API on :8000
cd ../frontend && npm install && npm run dev                            # UI on :5173
```

## Credits

Design: [Dimension by HTML5 UP](https://html5up.net) (CCA 3.0, see `LICENSE.txt`). Icons: Font Awesome Free.
