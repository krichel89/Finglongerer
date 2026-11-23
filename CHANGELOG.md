# Änderungen

Versionierung nach `MAJOR.MINOR.PATCH`. Neue Version setzen: `node scripts/set-version.mjs 0.3.0`
(ändert `package.json`, `www/version.js` und die Android-Version zugleich), dann hier eintragen, committen
und mit `git tag v0.3.0 && git push --tags` markieren – das erzeugt ein GitHub-Release mit der APK.

## 0.2.1 – 2026-11-23
- Behoben: „App nicht installiert" beim Update – die APK wird jetzt bei jedem Build mit demselben Schlüssel signiert (einmalig muss die alte App deinstalliert werden)

## 0.2.0 – 2026-11-23
- Neu: Version unter ⚙ Einstellungen sichtbar
- Neu: Bereich „Erweitert" (eingeklappt, unten) mit der Box-Verwaltung
- Neu: automatische Suche nach Boxen im WLAN
- Neu: Gruppe (in den Einstellungen festlegbar) mit eigenem Knopf „AUX an"
- Neu: Knöpfe dunkelgrau; eingeschaltet = orange leuchtende Schrift, wartet auf die Box = blinkend
- Behoben: „AUX an" schaltete auf Bluetooth (jetzt direkte Auswahl von AUX)

## 0.1.0 – 2026-11-23
- Erste Version: AUX an/aus, Lautstärke, Gesamtlautstärke mit Balance (virtuell bzw. im Stereopaar echt), Stereopaar bilden/auflösen
