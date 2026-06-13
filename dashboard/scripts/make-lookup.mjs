// Transform a dist-export CSV into a VLOOKUP-ready table.
//
// Output columns (match_key first, so VLOOKUP works directly):
//   match_key,distance_km,eta_mins,fromLat,fromLon,toLat,toLon
//
// match_key is the cache key without the "dist:v1:" prefix, i.e.
//   "<lat1>,<lon1>><lat2>,<lon2>"  (each coord = exactly 5 decimals)
//
// In your Excel sheet, build the same key from full-precision coords with:
//   =TEXT(lat1,"0.00000")&","&TEXT(lon1,"0.00000")&">"&TEXT(lat2,"0.00000")&","&TEXT(lon2,"0.00000")
// then VLOOKUP that against this file.
//
//   node scripts/make-lookup.mjs <dist-export-*.csv>

import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/make-lookup.mjs <dist-export-*.csv>");
  process.exit(1);
}

const text = readFileSync(src, "utf-8").replace(/^﻿/, "");

// Minimal RFC-4180 parser (handles quoted fields with commas/quotes).
function parseCSV(s) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvCell(v) {
  const x = String(v ?? "");
  return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
}

const rows = parseCSV(text);
const header = rows[0];
const idx = Object.fromEntries(header.map((h, j) => [h, j]));

const outHeader = ["match_key", "distance_km", "eta_mins", "fromLat", "fromLon", "toLat", "toLon"];
const out = [outHeader.join(",")];

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row[idx.key] == null) continue;
  const matchKey = String(row[idx.key]).replace(/^dist:v1:/, "");
  out.push([
    csvCell(matchKey),
    csvCell(row[idx.distance_km]),
    csvCell(row[idx.eta_mins]),
    csvCell(row[idx.fromLat]),
    csvCell(row[idx.fromLon]),
    csvCell(row[idx.toLat]),
    csvCell(row[idx.toLon]),
  ].join(","));
}

const dst = src.replace(/\.csv$/i, "") + "-lookup.csv";
writeFileSync(dst, "﻿" + out.join("\n"), "utf-8");
console.log(`Wrote ${out.length - 1} rows → ${dst}`);
