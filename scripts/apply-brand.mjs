#!/usr/bin/env node
// Propagate /brand.json (the single place to rename the app) into Tauri config and index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));

const confPath = join(root, "app/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.productName = brand.name;
conf.identifier = brand.identifier;
conf.version = brand.version;
for (const w of conf.app.windows) w.title = brand.name;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const htmlPath = join(root, "app/index.html");
const html = readFileSync(htmlPath, "utf8").replace(/<title>.*<\/title>/, `<title>${brand.name}</title>`);
writeFileSync(htmlPath, html);
console.log(`brand applied: ${brand.name} (${brand.identifier} ${brand.version})`);
