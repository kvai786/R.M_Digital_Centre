"use strict";
// Copies only the public web assets into www/ so server code, .env and credentials never ship in the APK.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "www");
const pattern = /\.(html|css|js|json|svg|png)$/i;
const excluded = new Set(["credentials.json", "package.json", "package-lock.json", "capacitor.config.json"]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    if (fs.statSync(file).isFile() && pattern.test(name) && !excluded.has(name)) {
        fs.copyFileSync(file, path.join(out, name));
    }
}
console.log("Prepared", out);
