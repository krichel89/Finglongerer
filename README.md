# STeasyremote

Schlanke Android-Fernbedienung für Bose SoundTouch mit ST Reborn – **ohne Server**, die App spricht die Boxen direkt im WLAN an.

- Pro Box: **AUX an**, **Aus** (Standby wird erkannt, POWER ist nur ein Umschalter), Lautstärke mit Obergrenze
- Oben: „Alle: AUX an" / „Alle: Aus"
- **Beide Boxen:** Gesamtlautstärke und Balance
  - ohne Stereopaar: *virtuelle* Balance (die abgewandte Box wird leiser)
  - im Stereopaar: *echte* Balance der Boxen (−7 … +7, per WebSocket)
- Stereopaar bilden und auflösen
- **Gruppe:** in ⚙ festgelegte Boxen mit einem Knopf auf AUX schalten
- Anzeige: Knöpfe dunkelgrau, eingeschaltet = orange leuchtende Schrift, wartet auf die Box = blinkend
- **Erweitert** (unten, eingeklappt): Boxen bearbeiten und **automatische Suche** im WLAN
- Boxen (Name, IP, max. Lautstärke) unter ⚙ einstellbar, bleiben gespeichert

## Version
Steht unter ⚙ Einstellungen. Neue Version: `node scripts/set-version.mjs 0.3.0`, `CHANGELOG.md` ergänzen, committen, dann `git tag v0.3.0 && git push --tags` – das erzeugt ein GitHub-Release mit der APK.

## APK bauen
GitHub → **Actions** → „APK bauen" → *Run workflow* (läuft auch bei jedem Push auf `main`).
Danach unter dem Lauf das Artefakt **Boxen-<Version>-apk** herunterladen (bei Tags zusätzlich unter *Releases*), auf dem Handy installieren
(„Installation aus unbekannten Quellen" erlauben). Handy und Boxen müssen im selben WLAN sein.

Lokal: `npm ci && npx cap sync android`, dann `android/` in Android Studio öffnen.

## Aufbau
- `www/core.js` – Logik (Port der Python-Version), `www/native.js` – Transport (native HTTP, WebSocket), `www/app.js` + `index.html` + `style.css` – Oberfläche
- `test/` – `npm test` prüft die Logik gegen simulierte Boxen (`test/mock_st.py`, benötigt Python 3)
- `server/soundtouch_fernbedienung.py` – frühere Variante als kleiner Server mit PWA (Stand 0.1, ohne Gruppe/Auto-Suche) (ohne Abhängigkeiten, `python3 soundtouch_fernbedienung.py`)

## Noch nicht an echter Hardware geprüft
- Balance schreiben: Nachrichtenformat und Port (8080, sonst 8090) stammen aus Community-Dokumentation; ob ST Reborn das unterstützt, ist offen.
- Stereopaar bilden (`/addGroup`): Format aus Dokumentation; die App prüft das Ergebnis und meldet Fehler.
- Sendet native HTTP-Anfragen mit XML-Body wie erwartet (Capacitor-HTTP-Plugin).
