# STeasyremote

Schlanke Android-Fernbedienung für Bose SoundTouch mit ST Reborn – **ohne Server**, die App spricht die Boxen direkt im WLAN an.

- Pro Box: **AUX an**, **Aus** (Standby wird erkannt, POWER ist nur ein Umschalter), Lautstärke mit Obergrenze
- Oben: „Alle: AUX an" / „Alle: Aus"
- **Beide Boxen:** Gesamtlautstärke und Balance
  - ohne Stereopaar: *virtuelle* Balance (die abgewandte Box wird leiser)
  - im Stereopaar: *echte* Balance der Boxen (−7 … +7, per WebSocket)
- Stereopaar bilden und auflösen
- Boxen (Name, IP, max. Lautstärke) unter ⚙ einstellbar, bleiben gespeichert

## APK bauen
GitHub → **Actions** → „APK bauen" → *Run workflow* (läuft auch bei jedem Push auf `main`).
Danach unter dem Lauf das Artefakt **Boxen-debug-apk** herunterladen, auf dem Handy installieren
(„Installation aus unbekannten Quellen" erlauben). Handy und Boxen müssen im selben WLAN sein.

Lokal: `npm ci && npx cap sync android`, dann `android/` in Android Studio öffnen.

## Aufbau
- `www/core.js` – Logik (Port der Python-Version), `www/native.js` – Transport (native HTTP, WebSocket), `www/app.js` + `index.html` + `style.css` – Oberfläche
- `test/` – `npm test` prüft die Logik gegen simulierte Boxen (`test/mock_st.py`, benötigt Python 3)
- `server/soundtouch_fernbedienung.py` – frühere Variante als kleiner Server mit PWA (ohne Abhängigkeiten, `python3 soundtouch_fernbedienung.py`)

## Noch nicht an echter Hardware geprüft
- Balance schreiben: Nachrichtenformat und Port (8080, sonst 8090) stammen aus Community-Dokumentation; ob ST Reborn das unterstützt, ist offen.
- Stereopaar bilden (`/addGroup`): Format aus Dokumentation; die App prüft das Ergebnis und meldet Fehler.
- Sendet native HTTP-Anfragen mit XML-Body wie erwartet (Capacitor-HTTP-Plugin).
