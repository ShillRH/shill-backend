# $SHILL project

This repo is the $SHILL project: a shill-to-earn token launchpad on Pons (Robinhood Chain).

## What deploys where

- **Website:** `site/index.html`. Netlify deploys it to https://shill.fyi automatically when changes are pushed to GitHub.
- **Backend:** everything else in the repo (API server, worker, SQL migrations). Railway deploys it automatically when changes are pushed to GitHub.

Every push to GitHub goes live, so only push changes that are ready.

## Workflow for every change

1. **Before any change:** get the latest from GitHub (`git pull`).
2. Make the change.
3. **Show the user what changed** (the diff) before committing.
4. Commit and push to GitHub.
