#!/bin/sh
# Copies the real static site into www/, the Capacitor webDir. This is a
# build artifact, not something to hand-edit - www/ is regenerated from
# scratch every run, so edit index.html/app.js/emission-factors.js/style.css/
# vendor/icons at the repo root as usual, then re-run this (via
# `npm run sync:ios`, which runs this before `cap sync ios`) before opening/
# building in Xcode.
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp index.html app.js emission-factors.js style.css manifest.json www/
cp -r vendor www/vendor
cp -r icons www/icons
echo "Synced web assets into www/"
