# Finglongerer

Android remote control for **Bose SoundTouch** speakers running SoundTouch Reborn (STR), with optional **Music Assistant** integration. **No server needed** – the app talks to your speakers directly over your home Wi-Fi.
Languages: English and German (follows the system language, switchable under ⚙ Settings).

## Features
- Per speaker or group: AUX, Bluetooth, Off, volume with a maximum limit, presets 1–6 (7–12 with the STR agent), long press saves what is playing
- Groups of any size (multiroom zones); with exactly two speakers also balance and stereo pair
- Now playing: title, artist, album, station and cover; play/pause/previous/next
- Move running music to another speaker or group, or add speakers to it
- Music Assistant: skip/pause controlled through MA when MA is the source (token needed)
- Play any stream URL (also via Android "Share")
- Automatic search for speakers and Music Assistant on your network
- Google TV / Android TV remote: controls the TV directly from the phone (automatic search, pairing code, keys, on/off, volume, apps); remotes are tabs with round icons - nothing to install on the TV
- Google TV / Android TV: same APK, appears in the launcher, remote-control navigation (OK held on a preset = save)
- Nothing is preconfigured: add your speakers and groups under ⚙ Settings

## Install
GitHub → **Actions** → latest run → artifact **Finglongerer-&lt;version&gt;-apk**; for tags also under *Releases*. Install the APK on your phone (allow installation from unknown sources). Phone and speakers must be on the same network.
The APK is debug-signed with a fixed, public key; it is meant for private use.

## License
MIT, see [LICENSE](LICENSE).

## Privacy
Everything stays on your phone and in your home network. No accounts, no analytics. Only private network addresses are accepted. Settings (including a Music Assistant token, if you enter one) are stored in the app's private storage; Android backup is disabled.

## Build
`npm ci && npm test` (needs Node 22 and Python 3), `npx cap sync android`, then build `android/` with Gradle or Android Studio.
New version: `node scripts/set-version.mjs X.Y.Z`, add a `## X.Y.Z` entry to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push --tags` (creates a GitHub release with the APK).
Structure: `www/core.js` logic, `www/native.js` transport and language, `www/i18n.js` texts, `www/app.js` + `index.html` + `style.css` UI, `test/` tests against simulated speakers.

---

# Finglongerer (Deutsch)

Android-Fernbedienung für **Bose SoundTouch** mit SoundTouch Reborn (STR) und optional **Music Assistant** – **ohne Server**, die App spricht die Boxen direkt im WLAN an. Sprachen: Deutsch und Englisch (folgt der Systemsprache, umschaltbar unter ⚙ Einstellungen).

## Funktionen
- Pro Box oder Gruppe: AUX, Bluetooth, Aus, Lautstärke mit Obergrenze, Sendertasten 1–6 (7–12 mit STR-Agent), langer Druck speichert das Laufende
- Gruppen beliebiger Größe (Multiroom-Zonen); bei genau zwei Boxen zusätzlich Balance und Stereopaar
- Laufender Titel, Interpret, Album, Sender und Cover; Play/Pause/Zurück/Weiter
- Laufende Musik auf eine andere Box oder Gruppe umziehen oder Boxen dazunehmen
- Music Assistant: Weiter/Pause über MA, wenn MA die Quelle ist (Token nötig)
- Beliebige Stream-URL abspielen (auch über „Teilen“)
- Automatische Suche nach Boxen und Music Assistant im Netz
- Google TV / Android TV als Fernbedienung: steuert den Fernseher direkt vom Handy (automatische Suche, Kopplung per Code, Tasten, Ein/Aus, Lautstärke, Apps); die Fernbedienungen liegen in Reitern mit runden Symbolen - auf dem Fernseher wird nichts installiert
- Google TV / Android TV: dieselbe APK, erscheint in der Programmübersicht, Bedienung per Fernbedienung (OK gehalten auf einer Sendertaste = speichern)
- Nichts vorbelegt: Boxen und Gruppen unter ⚙ Einstellungen anlegen

## Installation
GitHub → **Actions** → letzter Lauf → Artefakt **Finglongerer-&lt;Version&gt;-apk** (bei Tags auch unter *Releases*), APK auf dem Handy installieren („Installation aus unbekannten Quellen“ erlauben). Handy und Boxen im selben Netz. Die APK ist mit einem festen, öffentlichen Debug-Schlüssel signiert und für den privaten Gebrauch gedacht.

## Lizenz
MIT, siehe [LICENSE](LICENSE).

## Datenschutz
Alles bleibt auf dem Handy und im Heimnetz. Keine Konten, keine Statistik. Es werden nur private Netzwerkadressen akzeptiert. Einstellungen (auch ein Music-Assistant-Token) liegen im privaten Speicher der App; das Android-Backup ist abgeschaltet.
