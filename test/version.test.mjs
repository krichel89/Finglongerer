// Prüft, dass die Version überall übereinstimmt.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const v = JSON.parse(r('package.json')).version;
assert.match(v, /^\d+\.\d+\.\d+$/);
assert.equal(/APP_VERSION = '([^']*)'/.exec(r('www/version.js'))[1], v, 'www/version.js');
const g = r('android/app/build.gradle');
assert.equal(/versionName "([^"]*)"/.exec(g)[1], v, 'build.gradle versionName');
const [a, b, c] = v.split('.').map(Number);
assert.equal(+/versionCode (\d+)/.exec(g)[1], a * 10000 + b * 100 + c, 'build.gradle versionCode');
assert.ok(r('CHANGELOG.md').includes('## ' + v), 'CHANGELOG.md hat keinen Eintrag für ' + v);
console.log('Version', v, 'überall konsistent');
