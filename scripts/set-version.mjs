// Setzt die Version an allen Stellen: node scripts/set-version.mjs 0.3.0
import { readFileSync, writeFileSync } from 'node:fs';
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('Aufruf: node scripts/set-version.mjs MAJOR.MINOR.PATCH'); process.exit(1); }
const [maj, min, pat] = v.split('.').map(Number);
const code = maj * 10000 + min * 100 + pat;
const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
edit('package.json', s => s.replace(/"version": "[^"]*"/, `"version": "${v}"`));
edit('package-lock.json', s => s.replace(/("name": "steasyremote",\s*"version": )"[^"]*"/g, `$1"${v}"`));
edit('www/version.js', () => `window.APP_VERSION = '${v}';\n`);
edit('android/app/build.gradle', s => s.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${v}"`));
console.log(`Version ${v} (versionCode ${code}) gesetzt. Jetzt CHANGELOG.md ergänzen, committen und mit "git tag v${v}" markieren.`);
