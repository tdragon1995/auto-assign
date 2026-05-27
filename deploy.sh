#!/bin/bash
set -e

# Abort if there are uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes detected. Commit and push first."
  git status --short
  exit 1
fi

# Abort if local is behind or ahead of origin/master
git fetch origin master --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "ERROR: Local branch is not in sync with origin/master. Push first."
  echo "  Local:  $LOCAL"
  echo "  Remote: $REMOTE"
  exit 1
fi

# Build
echo "Building..."
cd dashboard && npm run build && cd ..

# Deploy
echo "Deploying..."
npx vercel --prod --scope longnguyenthanh075-5963s-projects
