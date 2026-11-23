// Vor einem Release: nichts Privates in den versionierten Dateien (Namen, Heimnetz-Adressen, Zugangsdaten).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !/\.(png|jar|keystore)$/.test(f) && f !== 'package-lock.json');
const rules = [
  [/Musikzimmer|Harald/i, 'persönliche Namen'],
  [/\b192\.168\.178\.\d/, 'konkrete Adresse im eigenen Heimnetz'],
  [/\b(?:10\.\d+\.\d+\.\d+|192\.168\.(?!1\.10\b)\d+\.\d+)/, 'konkrete Heimnetz-Adresse'],
  [/(?:api_?key|access_token|token)=[A-Za-z0-9]{16,}/i, 'Zugangsschlüssel'],
  [/\b[0-9a-f]{32}\b/i, '32-stellige Kennung (Schlüssel?)'],
];
const allowed = new Set(['www/core.js:scan']);          // Suchbereiche 192.168.x.x der automatischen Suche
for (const f of files) {
  const lines = readFileSync(root + f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, what] of rules) {
      if (!re.test(line)) continue;
      if (what === 'Zugangsschlüssel' && f === 'test/core.test.mjs' && /GEHEIMSCHLUESSEL/.test(line)) continue;   // erfundener Wert für den Schwärzungs-Test
      if (what === 'konkrete Heimnetz-Adresse' && (f === 'www/core.js' && /guessPrefixes|192\.168\.178', '192\.168\.0'/.test(line) || f.startsWith('test/') || /^\s*(?:\/\/|#)/.test(line) || /127\./.test(line))) continue;
      assert.fail(f + ':' + (i + 1) + ': ' + what + ': ' + line.trim().slice(0, 100));
    }
  });
}
console.log('Hygiene:', files.length, 'Dateien ohne Persönliches');
