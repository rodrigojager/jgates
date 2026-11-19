#!/bin/sh
set -eu

GITHUB_TOKEN="${GITHUB_TOKEN:?set GITHUB_TOKEN in the environment}"
export GITHUB_TOKEN
git push origin main
