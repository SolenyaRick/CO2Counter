#!/bin/sh
# Copies the real static site into www/, the Capacitor webDir. This is a
# build artifact, not something to hand-edit - www/ is regenerated from
# scratch every run, so edit index.html/app.js/data.js/style.css/vendor/
# icons at the repo root as usual, then
# re-run this (via `npm run sync:ios`, which runs this before
# `cap sync ios`) before opening/building in Xcode.
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp index.html app.js data.js airports.js places.js style.css manifest.json www/
cp -r about greener-switches how-we-calculate example privacy terms www/
cp -r vendor www/vendor
cp -r icons www/icons
echo "Synced web assets into www/"
