# Änderungen

Versionierung nach `MAJOR.MINOR.PATCH`. Neue Version setzen: `node scripts/set-version.mjs 0.3.0`
(ändert `package.json`, `www/version.js` und die Android-Version zugleich), dann hier eintragen, committen
und mit `git tag v0.3.0 && git push --tags` markieren – das erzeugt ein GitHub-Release mit der APK.

## 0.5.0
- Gruppen spielen jetzt synchron: AUX, Bluetooth und Sendertasten wirken auf die erste Box der Gruppe (Master), die übrigen Boxen werden als Multiroom-Zone (`/setZone`) angekoppelt und per `/getZone` geprüft.
- Gruppe „Aus": nacheinander (Master zuerst), damit eine Folge-Box nicht wieder geweckt wird.
- Stereopaare und Gruppen mit einer Box verhalten sich wie bisher.

## 0.4.0 – 2026-11-23
- Neu: Startseite zeigt Gruppen und Einzelboxen gleichrangig als zugeklappte Karten; Antippen klappt auf
- Neu: Sortieren (Knopf ⇅ oben): Reihenfolge ändern; Reihenfolge und aufgeklappte Karten werden gemerkt
- Neu: Bluetooth-Knopf (bei Gruppen und Einzelboxen)
- Neu: ausklappbar „Sender (Tasten 1–6)": drückt die Sendertasten 1–6 der Box (bei Gruppen an allen Boxen, im Stereopaar nur an der linken); zeigt die Namen, soweit die Box sie meldet
- Entfernt: Bereich „Erweitert" (Einzelboxen stehen jetzt gleichrangig auf der Startseite)

## 0.3.0 – 2026-11-23
- Neu: Startseite zeigt nur noch Gruppen. Beliebig viele Gruppen mit beliebig vielen Boxen (2er, 3er, 4er …), unter ⚙ Einstellungen → Gruppen anlegbar
- „Beide Boxen" ist jetzt eine normale Gruppe; Balance und Stereopaar gibt es bei Gruppen mit genau zwei Boxen
- Gruppenkarte: AUX an, Aus, Gesamtlautstärke (jede Box auf ihr eigenes Maximum begrenzt)
- Boxen-Verwaltung und Auto-Suche wandern in ⚙ Einstellungen; unter „Erweitert" (eingeklappt) stehen Ein/Aus und Lautstärke der einzelnen Boxen
- Optik: einfaches Orange statt Leuchtschrift (blinkt weiterhin beim Warten)
- Die Einstellungen aus 0.2 werden übernommen (die bisherige Gruppe wird zu „Beide Boxen")
- Entfernt: „Alle: AUX an/Aus" (dafür eine Gruppe mit allen Boxen anlegen)

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
