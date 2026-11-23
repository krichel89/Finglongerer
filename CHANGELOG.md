# Änderungen

Versionierung nach `MAJOR.MINOR.PATCH`. Neue Version setzen: `node scripts/set-version.mjs 0.3.0`
(ändert `package.json`, `www/version.js` und die Android-Version zugleich), dann hier eintragen, committen
und mit `git tag v0.3.0 && git push --tags` markieren – das erzeugt ein GitHub-Release mit der APK.

## 0.11.0
- Laufender Titel: unter dem Namen jeder Box/Gruppe steht „Interpret – Titel" (bei Radio der Sendername), bei Gruppen die Angabe der Master-Box. Quelle: `/now_playing` (`track`, `artist`, `stationName`).
- Player-Tasten (Zurück, Play/Pause, Weiter) oben im aufgeklappten Eintrag, gesendet als `PREV_TRACK`/`PLAY_PAUSE`/`NEXT_TRACK` an `/key`; bei Gruppen an die Master-Box. Bei Radio nur Play/Pause, bei AUX/Standby gar nicht. Ob die Box die Tasten bei jeder Quelle (Spotify, STR, MA) annimmt, ist nicht verifiziert.
- Umziehen bei laufender Musik (ganz unten im Eintrag): Ziel wählen, dann „Umziehen" (gleicher Inhalt per `/select` auf der Ziel-Box, erst wenn er dort läuft, gehen die Quell-Boxen aus; Titel beginnt vermutlich von vorn) oder „Dazunehmen" (Zone, Musik läuft ohne Pause weiter, Quelle bleibt Master). AUX und Bluetooth lassen sich nicht umziehen, nur dazunehmen. Spotify/MA/STR-Streams: ungetestet; übernimmt das Ziel die Quelle nicht, bleibt die Quelle an.

## 0.10.0
- App heißt jetzt **STEasy** (Name unter dem Icon, Titel, Kopfzeile, APK-Dateiname `STEasy-<Version>.apk`). Die App-ID bleibt, Updates laufen weiter über die alte Installation.
- Immer nur ein Eintrag (Box oder Gruppe) ist aufgeklappt; ein anderer öffnet, der vorherige schließt.
- Doppeltipp auf den Balanceregler setzt ihn in die Mitte.

## 0.9.0
- Stream-URL: ganz unten „Stream-URL abspielen" – Adresse eintragen, Box oder Gruppe wählen, Abspielen (`POST :8888/api/play` am STR-Agenten; die Box holt den Stream selbst). Bei Gruppen spielt die Master-Box, die anderen folgen per Zone.
- „Teilen" aus anderen Android-Apps: Text/Link an „Boxen" teilen füllt das Feld (Adresse wird aus dem Text gezogen); gespielt wird erst nach Auswahl des Ziels.

## 0.8.0
- Zweite Sender-Reihe heißt jetzt 7 bis 12, ist extra ausklappbar („Weitere Sender (7–12)") und zeigt nur belegte Slots mit Namen; ist sie leer, entfällt sie. Kann die App die Belegung nicht lesen, zeigt sie alle sechs.
- Hinweis „Lang drücken = Laufendes speichern" steht unter den Tasten 1–6.
- Erläuterungen zu Balance und Lautstärke entfallen (nur noch Zahl bzw. Regler); Ausklapp-Pfeile größer und heller.

## 0.7.0
- Langer Druck auf eine Sendertaste (1–6 und 1–6 · 2×) speichert, was gerade läuft (Radio, Spotify, Bibliothek/Jellyfin-Ordner über STR), nach Rückfrage auf diese Taste: `POST :8888/api/box/save-playing {"slot":N}`. Bei einer Gruppe zählt die Master-Box.

## 0.6.0
- Zweite Sender-Reihe (STR: Taste doppelt gedrückt, Slots 7–12): erscheint unter den Tasten 1–6 als „1 · 2×" … „6 · 2×", wenn der STR-Agent der Box (Port 8888, `/api/agent/version`) `presetRows: 2` meldet. Abgespielt wird über `POST /api/play/<slot>` am Agenten. Namen der Slots 7–12 werden noch nicht angezeigt (Lese-Schnittstelle unbekannt).

## 0.5.2
- Hauptseite aufgeräumt: Links/Rechts-Tausch wandert in die Einstellungen (Gruppen → „⇆ tauschen" bei Gruppen mit zwei Boxen), die Erläuterungen zur Balance und der Mitte-Knopf entfallen.

## 0.5.1
- Knappere Beschriftung: „AUX", „BT"; Quellenanzeige „Internetradio" statt „LOCAL_INTERNET_RADIO" (weitere Quellen mit lesbaren Namen).
- Die laufende Sendertaste (1–6) wird orange markiert (Abgleich der laufenden Quelle mit /presets, sobald die Senderliste geöffnet ist).

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
