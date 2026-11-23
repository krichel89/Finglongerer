// Prüft, dass die App für Google TV / Android TV startbar bleibt (Startsymbol, Banner, kein Touchscreen nötig).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const r = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const m = r('android/app/src/main/AndroidManifest.xml');
assert.match(m, /android\.intent\.category\.LEANBACK_LAUNCHER/, 'LEANBACK_LAUNCHER fehlt');
assert.match(m, /android\.intent\.category\.LAUNCHER/, 'LAUNCHER (Handy) fehlt');
assert.match(m, /android:name="android\.hardware\.touchscreen"\s+android:required="false"/, 'touchscreen muss optional sein');
assert.match(m, /android:name="android\.software\.leanback"\s+android:required="false"/, 'leanback muss optional sein');
assert.match(m, /android:banner="@drawable\/banner"/, 'Banner fehlt im Manifest');
assert.ok(existsSync(new URL('../android/app/src/main/res/drawable-xhdpi/banner.png', import.meta.url)), 'banner.png fehlt');
assert.match(r('android/app/src/main/java/de/krichel/finglongerer/MainActivity.java'), /"STDevice"/, 'STDevice-Brücke fehlt');
assert.match(r('www/native.js'), /classList\.add\('tv'\)/, 'TV-Klasse wird nicht gesetzt');
assert.match(r('www/style.css'), /\.tv :focus/, 'Fokus-Stil für TV fehlt');
assert.match(r('www/app.js'), /window\.STBack =/, 'Zurück-Behandlung fehlt');
assert.match(r('android/app/src/main/java/de/krichel/finglongerer/MainActivity.java'), /OnBackPressedCallback/, 'Back-Callback fehlt');
// Fernseher direkt ansprechen (Android-TV-Fernbedienungsprotokoll)
const main = r('android/app/src/main/java/de/krichel/finglongerer/MainActivity.java');
assert.match(main, /"STTv"/, 'STTv-Brücke fehlt');
assert.match(main, /ERR:ip/, 'Heimnetz-Prüfung der TV-Brücke fehlt');
const rem = r('android/app/src/main/java/de/krichel/finglongerer/TvRemote.java');
assert.match(rem, /pairPort, int remotePort/, 'TvRemote fehlt'); assert.ok(existsSync(new URL('../android/app/src/main/java/de/krichel/finglongerer/TvIdentity.java', import.meta.url)));
assert.match(r('www/native.js'), /STTv/, 'native.js ruft STTv nicht auf');
for (const id of ['tv-ip', 'tv-pair', 'tv-code-go', 'tv-find', 'tvview', 'tabs']) assert.ok(r('www/index.html').includes('id="' + id + '"'), id + ' fehlt in index.html');
assert.match(r('www/app.js'), /\['Jellyfin', 'market:\/\/launch\?id=org\.jellyfin\.androidtv'\]/, 'Jellyfin muss die erste App sein');
assert.ok(!/Disney/.test(r('www/app.js')), 'Disney+ wurde entfernt');
assert.match(r('www/app.js'), /k\('🔇', 91,/, 'Stumm muss KEYCODE_MUTE (91) senden');
assert.match(r('android/app/src/main/java/de/krichel/finglongerer/MainActivity.java'), /String scan\(String prefix\)/, 'Fernseher-Suche fehlt');
console.log('Google-TV-Grundlagen vorhanden');
