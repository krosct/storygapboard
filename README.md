# StoryGapBoard

🎬 Turn a short story, plus optional notes, reference images and panels of your own, into a **storyboard**:
one image with a grid of panels, made by an image model on [OpenRouter](https://openrouter.ai) or
[OpenAI](https://developers.openai.com/api/docs/guides/image-generation). Then
retouch any detail of one panel without touching the rest. Visitors use their own API key.

![StoryGapBoard home page](img/home.jpg)

## ✨ Features

- ✍️ **Generate**: optional story (empty = the model completes it from your panels), layout (1x3 to 3x2),
  panel ratio, size, format and seed.
- 🧩 **Panels**: the layout as boxes; drop your own image in some (drag to frame it) and the model draws
  the rest.
- 🖼️ **Storyboard**: every panel in the chosen shape. Drag to reframe, download one panel, undo/redo.
- 🎨 **Frame**: dress the storyboard: 12 ready-made looks, background (color, gradients, patterns), margin and
  gaps, outer frame, title, and each panel's border (color, line style, thickness), rounded corners, shadow and
  number badge. Live preview; the storyboard follows every change.
- 🖌️ **Retouch**: mark a detail (circle, rectangle or brush), say what to change; only that area is
  blended in, in the browser. Undo/redo per panel, and a draggable divider compares before and after.
- 🤖 **Model**: OpenRouter or OpenAI, with your key. 📎 **Files**: up to 5 (5 MB each): `.txt`/`.md` as
  context, PNG/JPEG/WebP/GIF as references.

🧭 **How it works**: the full pipeline (diagrams and every step with an example) and a walkthrough with
real files in [examples/](examples/README.md).

## 📸 Screenshots

| Generate | Storyboard |
|---|---|
| ![Generate: story, ratio, layout, size, format, seed and the panel grid with one fixed panel](img/generate.jpg) | ![The storyboard: two panels of your own and one drawn by the model, with the panel buttons and undo, redo, open and download](img/storyboard.jpg) |
| **Retouch** | **Files** |
| ![Retouch: brush marks on one panel, the lit area that may change and the changing area option](img/retouch.jpg) | ![Files: a text note used as context and an image used as reference](img/files.jpg) |
| **Model** | **About** |
| ![Model: provider, image model and API key](img/model.jpg) | ![About: how it works, privacy and fair use](img/about.jpg) |

<p align="center"><img src="img/mobile-home.jpg" alt="Home page on a phone" width="260"></p>

## 🔒 Privacy & security

- 🔑 The API key lives only in the open tab: never stored, never logged.
- 🧠 Files and images are processed in memory, never saved (the development debug dump below cannot
  turn on in production).
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

GitHub Actions tests every push; on `main` it builds and publishes with devkit (or by hand:
`~/Documentos/devkit/deploy.sh vps HOST`), with health check, automatic rollback and HTTPS through the
server's shared Caddy (Cloudflare supported).

Setup: repository **variable** `DEPLOY_ENABLED=true`, and in the `vars` environment `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SITE_ADDRESS`; optional `DEPLOY_PATH`,
`DEPLOY_PORT`, `DEPLOY_ORIGIN_CERT`/`DEPLOY_ORIGIN_KEY`, `DEPLOY_PRESERVE` and `DEPLOY_<KEY>` for the
settings of `.env.example` (add new ones to the `env` input of the deploy job in
`.github/workflows/ci-cd.yml`). Each deploy rewrites the server's `.env` from them; with
`DEPLOY_PRESERVE=true` existing server values stay. `LOG_HASH_SALT` is generated once and kept.

## 🛠️ Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m unittest discover -s tests -t .   # tests
../.venv/bin/uvicorn app.main:app --reload                              # API on :8000
cd ../frontend && npm install && npm run dev                            # UI on :5173
```

Two settings for local development only, in `.env` (both are ignored whenever `PUBLIC_URL` is set, as
on the server, so they can never turn on in production):

- 🧪 `DEBUG_FAKE_MODEL=1`: a simulated model. Generations and retouches return test images instantly,
  for free, without any key: handy to work on the panels, the retouch window or the blend.
- 🔍 `DEBUG_DUMP_DIR=data/debug`: every job gets a folder with what was sent (final prompt, parameters,
  images; never the key), the model's raw answer, and what the browser made of it (board, retouch mask,
  blended panel).

## 🙏 Credits

StoryGapBoard created by [Gabriel Monteiro](https://krosct.github.io/).

Design: [Dimension by HTML5 UP](https://html5up.net) (CCA 3.0, see `LICENSE.txt`). Icons: Font Awesome Free.
