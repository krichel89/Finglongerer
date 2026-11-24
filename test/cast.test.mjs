// Prüft das Chromecast-Modul (JBL-Lautsprecher): Bestandteile vorhanden und CastLink gegen einen simulierten Lautsprecher.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const r = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const J = 'android/app/src/main/java/de/krichel/finglongerer/';
const main = r(J + 'MainActivity.java');
assert.match(main, /"STCast"/, 'STCast-Brücke fehlt');
assert.match(main, /CastLink\.lanIp\(ip\)/, 'Heimnetz-Prüfung der Chromecast-Brücke fehlt');
assert.match(r(J + 'CastLink.java'), /urn:x-cast:com\.google\.cast\.receiver/, 'Chromecast-Protokoll fehlt');
assert.match(r('www/native.js'), /STCast/, 'native.js ruft STCast nicht auf');
for (const id of ['jblview', 'jblbody', 'cast-find', 'cast-add', 'cast-list', 'tab-jbl']) assert.ok(r('www/index.html').includes('id="' + id + '"'), id + ' fehlt in index.html');
assert.match(r('www/index.html'), /data-tab="jbl"/, 'Reiter fehlt');

// Protokolltest: braucht Java (javac), Python 3 und openssl - fehlt etwas, wird dieser Teil übersprungen
const has = c => spawnSync(c, ['--version'], { stdio: 'ignore' }).error === undefined || spawnSync(c, ['-version'], { stdio: 'ignore' }).error === undefined;
if (!['javac', 'java', 'python3', 'openssl'].every(has)) { console.log('Chromecast: Bestandteile ok (Protokolltest übersprungen, Werkzeug fehlt)'); process.exit(0); }
const root = new URL('..', import.meta.url).pathname, tmp = mkdtempSync(join(tmpdir(), 'cast-'));
let mock;
try {
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=mockcast'], { stdio: 'ignore' });
  assert.equal(cert.status, 0, 'Zertifikat konnte nicht erzeugt werden');
  const src = ['CastLink', 'MiniJson', 'TvScan', 'TvRemote', 'TvIdentity'].map(n => join(root, J, n + '.java')).concat(join(root, 'test/CastLinkTest.java'));
  const jc = spawnSync('javac', ['-encoding', 'UTF-8', '-d', join(tmp, 'cls'), ...src], { encoding: 'utf8' });
  assert.equal(jc.status, 0, 'javac: ' + (jc.stderr || '').split('\n').filter(l => !l.startsWith('Picked up')).join('\n'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  mock = spawn('python3', [join(root, 'test/mock_cast.py'), String(port), tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { mock.stdout.on('data', d => { if (String(d).includes('ready')) res(); }); mock.on('exit', () => rej(new Error('Simulation startet nicht'))); setTimeout(() => rej(new Error('Simulation startet nicht (Zeit)')), 10000); });
  const run = spawnSync('java', ['-cp', join(tmp, 'cls'), 'de.krichel.finglongerer.CastLinkTest', String(port)], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, 'Chromecast-Test:\n' + run.stdout + run.stderr);
  assert.match(run.stdout, /ALLES OK/);
  console.log('Chromecast: Protokoll gegen simulierten Lautsprecher ok');
} finally {
  if (mock) mock.kill();
  rmSync(tmp, { recursive: true, force: true });
}
