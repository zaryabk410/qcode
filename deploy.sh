#!/usr/bin/env bash
# QCode deploy to GitHub Pages over SSH.
# Usage:  ./deploy.sh [repo-name]      (default: qcode)
# Needs: git + working SSH key on GitHub (ssh -T git@github.com).
# gh CLI is optional — if present it auto-creates the repo and enables Pages.
set -euo pipefail

REPO="${1:-qcode}"
cd "$(dirname "$0")"

command -v git >/dev/null || { echo "git not installed"; exit 1; }

# Detect GitHub username from SSH greeting: "Hi <user>! You've successfully authenticated..."
GH_USER="$(ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | sed -n 's/^Hi \([^!]*\)!.*/\1/p' || true)"
if [ -z "$GH_USER" ]; then
  read -rp "GitHub username: " GH_USER
fi
REMOTE="git@github.com:$GH_USER/$REPO.git"
echo "==> User: $GH_USER   Repo: $REPO   Remote: $REMOTE"

# Init + commit
if [ ! -d .git ]; then
  git init -q
fi
git checkout -q -B main
git add -A
git commit -qm "Deploy QCode" || echo "==> Nothing new to commit"

# Remote
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

HAS_GH=0
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && HAS_GH=1

# Create repo if missing
if ! git ls-remote origin >/dev/null 2>&1; then
  if [ "$HAS_GH" = 1 ]; then
    echo "==> Creating repo with gh"
    gh repo create "$GH_USER/$REPO" --public
  else
    echo
    echo "Repo does not exist yet. Create it (empty, no README):"
    echo "   https://github.com/new?name=$REPO&visibility=public"
    read -rp "Press Enter once created... "
  fi
fi

git push -u origin main

# Enable Pages (source = GitHub Actions)
if [ "$HAS_GH" = 1 ]; then
  gh api -X POST "repos/$GH_USER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
    || gh api -X PUT "repos/$GH_USER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 || true
  sleep 3
  gh workflow run deploy.yml -R "$GH_USER/$REPO" >/dev/null 2>&1 || true
  echo "==> Pages enabled. Watch: gh run watch -R $GH_USER/$REPO"
else
  echo
  echo "One-time step — enable Pages:"
  echo "   https://github.com/$GH_USER/$REPO/settings/pages"
  echo "   Source: GitHub Actions"
  echo "Then re-run the workflow:"
  echo "   https://github.com/$GH_USER/$REPO/actions  -> 'Deploy QCode to GitHub Pages' -> Run workflow"
fi

echo
echo "==> Live URL (after ~1 min): https://$GH_USER.github.io/$REPO/"
echo "==> Future updates: git add -A && git commit -m update && git push"