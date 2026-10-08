# StoryGapBoard

🎬 Turn a short story, plus optional notes and reference images, into a **storyboard**: one image with a grid
of panels, made by any image model on [OpenRouter](https://openrouter.ai). Visitors use their own API key.

![StoryGapBoard home page](img/home.jpg)

## ✨ Features

- ✍️ **Generate**: story prompt, ratio, layout (1x3, 1x6, 2x1, 2x2, 2x3, 3x1, 3x2), size, format and seed.
- 🖼️ **One storyboard per generation**, downloaded straight to your browser.
- 📎 **Files**: up to 5 files (5 MB each).
  - 📝 `.txt` / `.md` → story context
  - 🎨 PNG / JPEG / WebP / GIF → visual references
- 🤖 **Model**: any OpenRouter image model.
- ℹ️ **About**: how it works, privacy and fair use.

## 📸 Screenshots

| Generate | Files |
|---|---|
| ![Generate: story prompt, ratio, layout, size, format and seed](img/generate.jpg) | ![Files: a text note used as context and an image used as reference](img/files.jpg) |
| **Model** | **About** |
| ![Model: OpenRouter image model and API key](img/model.jpg) | ![About: how it works, privacy and fair use](img/about.jpg) |

<p align="center"><img src="img/mobile-home.jpg" alt="Home page on a phone" width="260"></p>

## 🔒 Privacy & security

- 🔑 The API key lives only in the open tab: never stored, never logged.
- 🧠 Files and images are processed in memory, never saved.
- 📊 The server keeps a private generation log with hashed IDs only (no keys, no raw IPs).
- 🛡️ Rate limits, one running generation per visitor, lock after repeated bad keys, strict security headers.

## 🚀 Run locally

Deploys and local runs use [devkit](https://github.com/krosct/devkit): this repository only has a
`deploy.conf` with what is specific to StoryGapBoard. Needs [uv](https://docs.astral.sh/uv/) and
Node.js 20.19+ / 22.12+.

```bash
~/Documentos/devkit/deploy.sh local          # http://localhost:8080 (Ctrl+C stops it)
```

It creates `.env` from `.env.example` the first time (every setting is optional), sets up `.venv`,
builds the frontend and serves the app. The generation log goes to `./data`.

## 📦 Deploy

- ⚙️ GitHub Actions tests every push; on `main` it builds the frontend and publishes the release with
  devkit (or by hand: `~/Documentos/devkit/deploy.sh vps HOST`).
- 🧰 Nothing to install on the server: devkit brings its own Python and runs the app as a user service.
- ↩️ Automatic rollback if a new release does not stay up or fails `/api/health`.
- 🌐 HTTPS through the server's shared Caddy, alongside other apps; Cloudflare supported (real visitor
  IP, Origin Certificate for "Full (strict)").
- 🗝️ The log salt (`LOG_HASH_SALT`) is generated on the first deploy and kept.

GitHub setup: repository **variable** `DEPLOY_ENABLED=true`, and in the `vars` environment:

| Secret | What |
|---|---|
| `DEPLOY_HOST`, `DEPLOY_USER` | the server and the SSH user |
| `DEPLOY_SSH_KEY` | private key used only for deploys |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <server>` |
| `DEPLOY_SITE_ADDRESS` | the app's domain (also a variable) |
| `DEPLOY_ORIGIN_CERT`, `DEPLOY_ORIGIN_KEY` | optional: Cloudflare Origin Certificate and key (PEM), for SSL "Full (strict)" |
| `DEPLOY_PATH`, `DEPLOY_PORT` | optional (default: `/srv/storygapboard` and 22) |
| `DEPLOY_<KEY>` | optional app settings, secret or variable, for the keys of `.env.example` except `LOG_HASH_SALT` (e.g. `DEPLOY_RATE_GENERATE_PER_DAY`) |

On every deploy the server's `.env` is replaced by these settings: a key that is not set goes back
to its default.

## 🛠️ Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m unittest discover -s tests -t .   # tests
../.venv/bin/uvicorn app.main:app --reload                              # API on :8000
cd ../frontend && npm install && npm run dev                            # UI on :5173
```

## 🙏 Credits

StoryGapBoard created by [Gabriel Monteiro](https://krosct.github.io/).

Design: [Dimension by HTML5 UP](https://html5up.net) (CCA 3.0, see `LICENSE.txt`). Icons: Font Awesome Free.
