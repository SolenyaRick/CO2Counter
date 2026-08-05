#!/usr/bin/env node
// Reads emission-factors-reference.xlsx and rewrites emission-factors.js's
// numbers to match - the "Value" column drives the code, not the other way
// round. Run this after editing the Value column in the spreadsheet:
//
//   npm run sync:factors
//
// Uses the same vendored SheetJS build the app itself uses for its Excel
// export (vendor/xlsx.js), so there's no extra dependency to install.
"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("../vendor/xlsx.js");

const ROOT = path.join(__dirname, "..");
const XLSX_PATH = path.join(ROOT, "emission-factors-reference.xlsx");
const JS_PATH = path.join(ROOT, "emission-factors.js");

function fail(message) {
  console.error("sync-emission-factors: " + message);
  process.exit(1);
}

if (!fs.existsSync(XLSX_PATH)) fail(`can't find ${XLSX_PATH}`);
if (!fs.existsSync(JS_PATH)) fail(`can't find ${JS_PATH}`);

// XLSX.readFile() shells out to Node's fs itself, but this vendored build is
// the browser bundle (fs access deliberately stubbed out) - read the bytes
// ourselves and hand XLSX just the buffer to parse instead.
const workbook = XLSX.read(fs.readFileSync(XLSX_PATH), { type: "buffer" });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
// header:1 -> array-of-arrays (not objects keyed by header text), so we can
// find the header row ourselves rather than assuming it's row 1 (there's a
// title/subtitle above it in this sheet).
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

const headerRowIndex = rows.findIndex((r) => r[0] === "Category" && r[2] === "Value");
if (headerRowIndex === -1) fail('could not find the header row (looking for "Category" / "Value" columns) - has the sheet layout changed?');

const header = rows[headerRowIndex];
const valueCol = header.indexOf("Value");
const jsPathCol = header.indexOf("JS Path");
if (valueCol === -1 || jsPathCol === -1) fail('sheet is missing a "Value" or "JS Path" column');

const entries = [];
for (let i = headerRowIndex + 1; i < rows.length; i++) {
  const jsPath = rows[i][jsPathCol];
  const value = rows[i][valueCol];
  if (!jsPath) continue; // section header / derived / informational row
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`row ${i + 1}: "${jsPath}" has a non-numeric Value (${JSON.stringify(value)}) - fix it in the spreadsheet and re-run.`);
  }
  entries.push({ jsPath, value });
}

if (entries.length === 0) fail("found no editable rows - is the sheet empty?");

let source = fs.readFileSync(JS_PATH, "utf8");
const changes = [];
const notFound = [];

function formatNumber(n) {
  // Match how these are already written in emission-factors.js: plain
  // decimals, no trailing zeros, no scientific notation for this range.
  return String(n);
}

for (const { jsPath, value } of entries) {
  const dot = jsPath.indexOf(".");
  const constName = dot === -1 ? jsPath : jsPath.slice(0, dot);
  const key = dot === -1 ? null : jsPath.slice(dot + 1);
  const escapedConst = constName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (key === null) {
    const re = new RegExp("(const\\s+" + escapedConst + "\\s*=\\s*)[-\\d.]+(?![\\w.])");
    const match = source.match(re);
    if (!match) { notFound.push(jsPath); continue; }
    const oldValue = match[0].slice(match[1].length);
    if (Number(oldValue) === value) continue; // unchanged - don't touch its formatting
    changes.push({ jsPath, oldValue, newValue: formatNumber(value) });
    source = source.replace(re, "$1" + formatNumber(value));
    continue;
  }

  // Nested object entry, e.g. TRANSPORT_FACTORS.car. Locate the object's
  // literal block first (const NAME = { ... };) - none of these are
  // multi-line nested objects, so the first "};" after the opening brace is
  // always that object's own closing, never a false match from something
  // else further down the file.
  const blockRe = new RegExp("(const\\s+" + escapedConst + "\\s*=\\s*\\{)([\\s\\S]*?)(\\};)");
  const blockMatch = source.match(blockRe);
  if (!blockMatch) { notFound.push(jsPath); continue; }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp("(\\b" + escapedKey + "\\s*:\\s*)[-\\d.]+(?![\\w.])");
  const keyMatch = blockMatch[2].match(keyRe);
  if (!keyMatch) { notFound.push(jsPath); continue; }

  const oldValue = keyMatch[0].slice(keyMatch[1].length);
  if (Number(oldValue) === value) continue; // unchanged - don't touch its formatting
  changes.push({ jsPath, oldValue, newValue: formatNumber(value) });
  const newBlockBody = blockMatch[2].replace(keyRe, "$1" + formatNumber(value));
  source = source.slice(0, blockMatch.index) + blockMatch[1] + newBlockBody + blockMatch[3] + source.slice(blockMatch.index + blockMatch[0].length);
}

if (notFound.length > 0) {
  fail(
    "these JS Path values from the spreadsheet don't match anything in emission-factors.js, so nothing was written:\n  - " +
      notFound.join("\n  - ") +
      "\n(Did a constant get renamed in emission-factors.js without updating the sheet's JS Path column?)"
  );
}

if (changes.length === 0) {
  console.log("sync-emission-factors: no changes - emission-factors.js already matches the spreadsheet.");
  process.exit(0);
}

// Sanity-check the rewritten source actually parses before touching the
// real file on disk.
const tmpPath = JS_PATH.replace(/\.js$/, ".sync-tmp.js");
fs.writeFileSync(tmpPath, source);
try {
  require("child_process").execFileSync(process.execPath, ["--check", tmpPath], { stdio: "pipe" });
} catch (err) {
  fs.unlinkSync(tmpPath);
  fail("the rewritten file failed to parse - not writing it. This is a bug in this script, not your spreadsheet edits:\n" + err.stderr);
}
fs.renameSync(tmpPath, JS_PATH);

console.log(`sync-emission-factors: updated ${changes.length} value(s) in emission-factors.js:\n`);
for (const c of changes) {
  console.log(`  ${c.jsPath}: ${c.oldValue} -> ${c.newValue}`);
}
console.log("\nReload the app to see the change. If you're about to build the iOS app, run `npm run sync:ios` too.");
