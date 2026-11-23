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
console.log('Google-TV-Grundlagen vorhanden');
