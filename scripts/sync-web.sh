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
cp -r about greener-switches how-we-calculate budget example privacy terms www/
cp -r vendor www/vendor
cp -r icons www/icons
# The iPhone app needs Capacitor's JavaScript core: the native bridge alone
# has no registerPlugin, so without it notifications and haptics can't run.
CORE=node_modules/@capacitor/core/dist/capacitor.js
[ -f "$CORE" ] || { echo "Missing $CORE - run npm install first"; exit 1; }
cp "$CORE" www/vendor/capacitor.js
for f in $(find www -name index.html); do
  sed -i.bak 's|<script src="vendor/supabase.js|<script src="vendor/capacitor.js"></script><script src="vendor/supabase.js|' "$f" && rm -f "$f.bak"
  grep -q 'vendor/capacitor.js' "$f" || { echo "Couldn't add Capacitor to $f"; exit 1; }
done
echo "Synced web assets into www/"
