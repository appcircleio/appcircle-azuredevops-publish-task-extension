#!/bin/env bash
# shellcheck shell=bash
set -euo pipefail

# Release pipeline for the Appcircle Publish Azure DevOps extension.
#
# Policy (aligned with the other Appcircle plugins, adapted to the Visual Studio
# Marketplace, which does NOT support pre-release/beta versions):
#   * Only a push/merge to the default branch (main) publishes a PRODUCTION version.
#   * There is no beta channel.
#   * The version is derived from the latest git tag (vX.Y.Z) — tagging is manual.

if [ -n "${PUBLISH_TOKEN:-}" ]; then
    echo "Publish token configured: yes"
else
    echo "Publish token configured: no"
fi

# --- Only main publishes. No beta. ------------------------------------------
if [ "${BRANCH_NAME:-}" != "main" ]; then
    echo "Branch '${BRANCH_NAME:-unknown}' is not 'main' — nothing to publish."
    exit 0
fi

# --- Version source of truth = latest git tag (manual tagging) --------------
git fetch --tags --force
LATEST_TAG="$(git tag --list --sort=-version:refname | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n1)"
VERSION="${LATEST_TAG#v}"
if [ -z "$VERSION" ] || ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "ERROR: no clean vX.Y.Z git tag found (latest: '${LATEST_TAG:-<none>}')." >&2
    exit 1
fi
echo "Publishing version: $VERSION (from tag ${LATEST_TAG})"

# --- Build + publish inside a node container --------------------------------
# (agent has Docker but no Node/yarn/tfx; tsc/tfx are installed globally here)
docker run --rm -i \
    -v "$PWD":/work -w /work \
    -e VERSION="$VERSION" \
    -e PUBLISH_TOKEN="$PUBLISH_TOKEN" \
    node:18 bash -s <<'DOCKER'
set -euo pipefail

echo "=== Runtime Dependencies ==="
node -v
yarn -v
npm install -g typescript@5 tfx-cli >/dev/null 2>&1
tfx version

echo "=== Install Dependencies ==="
yarn install
(cd task && yarn install)

# --- Inject the git-tag version into the manifests --------------------------
echo "=== Set manifest version ==="
node -e '
const fs = require("fs");
const v = process.env.VERSION.split(".");
const task = JSON.parse(fs.readFileSync("task/task.json"));
task.version = { Major: +v[0], Minor: +v[1], Patch: +v[2] };
fs.writeFileSync("task/task.json", JSON.stringify(task, null, 2) + "\n");
const ext = JSON.parse(fs.readFileSync("vss-extension.json"));
ext.version = process.env.VERSION;
fs.writeFileSync("vss-extension.json", JSON.stringify(ext, null, 2) + "\n");
console.log("Manifests set to " + process.env.VERSION);
'

echo "=== Build Package ==="
yarn package

echo "=== Create & Publish Extension (public production) ==="
tfx extension create --manifest-globs vss-extension.json --overrides-file configs/release.json
tfx extension publish --manifest-globs vss-extension.json --overrides-file configs/release.json --token "$PUBLISH_TOKEN"
DOCKER

exit 0
