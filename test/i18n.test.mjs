// Prüft die Übersetzungen: beide Sprachen vollständig, gleiche Platzhalter, alle im Code benutzten Schlüssel vorhanden, Spracherkennung.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const I = require('../www/i18n.js');
const { de, en } = I.DICT;
const r = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort(), 'Deutsch und Englisch haben dieselben Schlüssel');
for (const k of Object.keys(de)) {
  const ph = s => (s.match(/\{\d+\}/g) || []).sort().join();
  assert.equal(ph(de[k]), ph(en[k]), 'Platzhalter in ' + k);
  assert.ok(de[k].trim() && en[k].trim(), 'leerer Text in ' + k);
}
const used = new Set();
for (const f of ['www/core.js', 'www/app.js', 'www/native.js']) for (const m of r(f).matchAll(/\b(?:T|t)\(\s*'([a-z][\w.]*)'/g)) used.add(m[1]);
for (const m of r('www/index.html').matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
for (const m of r('www/core.js').matchAll(/T\('key\.' \+ key\)/g)) ['PLAY_PAUSE', 'PREV_TRACK', 'NEXT_TRACK'].forEach(k => used.add('key.' + k));
for (const m of r('www/app.js').matchAll(/'(src\.\w+)'/g)) used.add(m[1]);
for (const m of r('www/native.js').matchAll(/'(err\.\w+)'/g)) used.add(m[1]);
for (const k of used) if (k !== 'key.') assert.ok(k in de, 'Schlüssel fehlt: ' + k);
const unused = Object.keys(de).filter(k => !used.has(k));
assert.deepEqual(unused, [], 'ungenutzte Schlüssel: ' + unused.join(', '));

assert.equal(I.resolve('auto', 'de-DE'), 'de'); assert.equal(I.resolve('auto', 'de'), 'de'); assert.equal(I.resolve('auto', 'en-US'), 'en');
assert.equal(I.resolve('auto', 'fr-FR'), 'en'); assert.equal(I.resolve('auto', ''), 'en'); assert.equal(I.resolve('auto', undefined), 'en');
assert.equal(I.resolve('de', 'en-US'), 'de'); assert.equal(I.resolve('en', 'de-DE'), 'en'); assert.equal(I.resolve('xx', 'de-AT'), 'de');
assert.equal(I.t('en', 'act.volume', 42), 'Volume 42'); assert.equal(I.t('de', 'act.volume', 42), 'Lautstärke 42');
assert.equal(I.t('de', 'gibt.es.nicht'), 'gibt.es.nicht');
console.log('Übersetzungen:', Object.keys(de).length, 'Texte in 2 Sprachen, Spracherkennung ok');
