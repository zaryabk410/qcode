# ⚡ QCode — free Claude-Code-style agent in the browser

Autonomous coding agent running **Qwen, Kimi and DeepSeek free models** via OpenRouter. Pure static site — no backend, deploys free on GitHub Pages.

## Features
- Agent loop: plans, reads/writes/edits/deletes files, runs JS in a sandboxed worker, iterates on results until `<done/>`
- SEARCH/REPLACE diff edits (whitespace-tolerant)
- File explorer + editor + live HTML preview (local CSS/JS inlined)
- Streaming responses, reasoning view for DeepSeek R1
- Auto-fallback across free models on 429/5xx
- Live fetch of current free Qwen/Kimi/DeepSeek model IDs (⟳)
- Import files / .zip, export workspace as .zip
- Slash commands: `/help /clear /reset /model /models /files /preview`
- Everything persisted in localStorage (key never leaves your browser except to the provider)

## Setup
1. Get a free key: https://openrouter.ai/keys
2. Open the app → ⚙ Settings → paste key → Save
3. Pick a model and type e.g. `build a snake game with score and restart`

Any OpenAI-compatible endpoint also works (change *API base URL*, e.g. DeepSeek, Moonshot, DashScope, or a local Ollama `http://localhost:11434/v1`).

## Deploy to GitHub Pages
**Automatic (script):**
```bash
gh auth login        # once
chmod +x deploy.sh
./deploy.sh qcode    # creates repo, pushes, enables Pages
```
URL: `https://<your-username>.github.io/qcode/`

**Manual:**
```bash
git init && git branch -M main
git add -A && git commit -m "QCode"
git remote add origin https://github.com/<you>/qcode.git
git push -u origin main
```
Then repo → Settings → Pages → Source: **GitHub Actions**. The included workflow deploys on every push to `main`.

## Run locally
```bash
python -m http.server 8080   # open http://localhost:8080
```

## Notes
- Free models have rate limits (~20 req/min, daily caps). Fallback switches models automatically.
- Free model IDs change over time — press ⟳ to refresh the list.
