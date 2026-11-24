# Änderungen

Versionierung nach `MAJOR.MINOR.PATCH`. Neue Version setzen: `node scripts/set-version.mjs 0.3.0`
(ändert `package.json`, `www/version.js` und die Android-Version zugleich), dann hier eintragen, committen
und mit `git tag v0.3.0 && git push --tags` markieren – das erzeugt ein GitHub-Release mit der APK.

## 0.23.0
- „Projektor suchen": findet LG-webOS-Geräte im Heimnetz (Steuerschnittstelle Port 3000/3001), meldet sich an (Anfrage am Projektor bestätigen) und trägt die MAC-Adresse automatisch ein.

## 0.22.0
- Projektor ein: In den Einstellungen die MAC-Adresse des Projektors eintragen, dann erscheint eine grüne Ein-Taste. Sie schickt fünf Weckrufe (Wake-on-LAN); der Projektor weckt den Stick über HDMI-CEC (SIMPLINK) mit.

## 0.21.4
- Texteingabe neu: Tastatur-Taste öffnet die Handy-Tastatur, der Text steht in der Taste und erscheint live im Eingabefeld des Fernsehers. Enter schickt ab. Meldet der Fernseher kein Eingabefeld, sagt die App das und tippt beim Senden ersatzweise Taste für Taste.
- Fernbedienung nutzt genau die Bildschirmhöhe, ohne Scrollen.
- QK: Beenden der Sprachsuche blockierte bis zu 3 Sekunden (Sperre zwischen Aufnahme und Brücke) - behoben.

## 0.21.3
- Sprachsuche: Das Mikrofon des Handys wird an den Fernseher gestreamt (Android fragt einmal nach der Mikrofon-Berechtigung). Erster Druck startet, zweiter beendet, nach 20 Sekunden endet es von selbst.
- Neben Play: Taste Zurück und Taste Vor. Kurz = Titel springen, lang = Zurück-/Vorspulen, solange gehalten.
- Einstellungen: Reiter (Bose, Google TV) einzeln ein-/ausblenden. Ist nur einer sichtbar, entfällt die Symbolreihe.

## 0.21.2
- Texteingabe: Absenden per Formular, damit Enter mit jeder Handy-Tastatur funktioniert (manche melden Enter nicht als Taste).
- Fernbedienung füllt die Bildschirmhöhe; Symbole statt Text: Aus (Kreis mit Strich), Mikrofon (Sprachsuche), Haus (Home), Pfeil (Zurück), Menü (drei Striche), Play/Pause. Die Ein-Taste entfällt.

## 0.21.1
- Texteingabe neu: Der Text wird über die Eingabemethode des Fernsehers eingefügt (wie in der Google-TV-App), nicht mehr als einzelne Tastendrücke. Umlaute und Sonderzeichen gehen jetzt. Enter am Handy schickt den Text und drückt dann Enter am Fernseher.
- Sprachsuche als kleine Taste neben dem Textfeld.
- Programmstarter (Jellyfin, YouTube, Netflix, Prime Video) entfernt.

## 0.21.0
- Suche neu: Eine Taste „Suche" (Tastencode SEARCH) springt in die Suche der gerade offenen App. Darunter ein Textfeld: am Handy tippen, Enter schickt den Text in das markierte Feld des Fernsehers und drückt dort Enter. Die Anbieter-Suchtasten entfallen.
- Ein: schickt immer zuerst einen Weckruf (Wake-on-LAN, jetzt auch an die Netz-Broadcast-Adresse), dann WAKEUP; war der Stick im Standby, zusätzlich die Power-Taste.

## 0.20.3
- Lauter, Leiser und Stumm entfernt; ⏻-Symbole an Ein/Aus entfernt.
- Ein/Aus und Funktionsmaske wieder wie in 0.20.1 (Aus funktionierte dort).
- Tastenbeschriftung wird bei langem Druck nicht mehr markiert.

## 0.20.2
- Funktionsmeldung wie die Referenzbibliothek (622): Lautstärke, Stumm und Power werden so zuverlässiger angenommen.
- Ein = WAKEUP, Aus = SLEEP (statt Umschalten nach Zustandsabfrage); wirkt auch, wenn der Stick wach, der Fernseher aber aus ist.
- Jellyfin startet über einen Intent-Link statt Play-Store-Link.

## 0.20.1
- Suche je Anbieter: Suchbegriff am Handy eintippen, dann „YouTube", „Netflix" oder „Prime Video" öffnet direkt die Suchergebnisse in der jeweiligen App (Enter startet YouTube).
- „In Eingabefeld des Fernsehers tippen" sendet den Text als Tastendrücke an das Feld, das auf dem Fernseher gerade Fokus hat (Umlaute werden zu ae/oe/ue, Sonderzeichen übersprungen).

## 0.20.0
- Reiter: Die Fernbedienungen liegen in runden Symbolen unter dem Titel. Bose = schwarzer Kreis mit weißem B, Google TV = schwarzes g im vierfarbigen Kreis. Der gewählte Reiter wird gemerkt.
- Fernseher automatisch finden: Einstellungen → „Fernseher suchen" (oder „Koppeln"/„Verbindung testen" ohne IP) durchsucht das Heimnetz nach Google-TV-Geräten und liest Name und MAC-Adresse.
- Ein und Aus sind getrennte Tasten. Die App fragt den Zustand des Fernsehers ab und drückt die Power-Taste nur, wenn er noch nicht im gewünschten Zustand ist. Antwortet der Stick im Standby gar nicht, schickt „Ein" einen Weckruf (Wake-on-LAN) an die gemerkte MAC-Adresse.
- Stumm sendet jetzt KEYCODE_MUTE (91, wie die Referenz-Bibliothek) statt VOLUME_MUTE (164).
- Apps: Jellyfin steht an erster Stelle, Disney+ entfällt.

## 0.19.0
- Google TV direkt steuern, ohne etwas auf dem Fernseher zu installieren: Die App spricht den Fernseher wie die Google-TV-App auf dem Handy an (Android-TV-Fernbedienungsprotokoll, Port 6467/6466). Einstellungen → „Fernseher (Google TV)": IP eintragen, „Koppeln", den Code vom Fernseher eingeben. Danach erscheint in der Hauptansicht die Karte „Fernseher" mit Ein/Aus, Lautstärke, Stumm, Play/Pause, Steuerkreuz, Zurück/Home/Menü und Apps (YouTube, Netflix, Disney+, Prime Video).
- Die Handy-Identität (selbst signiertes Zertifikat) wird beim ersten Koppeln im privaten App-Ordner angelegt. Nur Heimnetz-Adressen sind erlaubt.
- Die TV-Oberfläche aus 0.18 (App auf dem Fernseher selbst) bleibt erhalten, wird aber nicht gebraucht.

## 0.18.1
- Zurück-Taste schließt zuerst Unterfenster (Einstellungen, aufgeklappte Bereiche) und verlässt erst dann die App. Gilt auf Handy und Fernseher.
- Fernseher: OK in einem Textfeld öffnet die Tastatur (auch die Handy-Tastatur der Google-TV-App) und schickt das Einstellungsformular nicht mehr ab.

## 0.18.0
- Google TV / Android TV: Die App erscheint in der Programmübersicht (mit Banner), braucht keinen Touchscreen und lässt sich mit der Fernbedienung bedienen. Dieselbe APK läuft auf Handy und Fernseher.
- Auf dem Fernseher: sichtbarer orangener Fokusrahmen, größere Schrift, Rand für Überscan, Gruppen in zwei Spalten. Sendertaste: OK kurz = abspielen, OK gehalten = Laufendes speichern.
- Neuer Test `test/tv.test.mjs` sichert die Manifest-Einträge ab.

## 0.17.2
- Statt des Lautstärke-Ausgleichs aus 0.17.1: eigenes Max je Box für AUX und Bluetooth (Einstellungen unter jeder Box, leer = wie Max). Der Regler zeigt immer die echte Box-Lautstärke und reicht bei AUX/Bluetooth bis zu diesem Max (bis 100).

## 0.17.0
- Einstellungen: Box neu starten. Schickt `sys reboot` an die Diagnose-Shell der Box (Port 17000), mit Rückfrage. Dafür gibt es im Android-Teil eine kleine TCP-Brücke, die nur diesen einen Befehl und nur Heimnetz-Adressen zulässt.
- Stereopaar bilden und auflösen sind ein Knopf: orange = Paar besteht (Druck löst es auf), grau = kein Paar (Druck bildet es).

## 0.16.10
- AUX bei Gruppen: Die Auswahl von AUX wird auf jeder Box erzwungen. Eine Folge-Box in einer Zone meldet die Quelle des Masters (AUX), ohne selbst auf AUX zu stehen; die App hatte das Wählen dann übersprungen.
- Folge-Boxen, deren Zone nur den Master meldet, entlassen sich jetzt selbst. Nach dem Auflösen wird geprüft, ob noch eine Zone besteht; sonst kommt eine Fehlermeldung.
- Die Diagnose zeigt je Box auch `/getZone` und `/getGroup`.

## 0.16.9
- AUX löst Gruppierungen auf: Wechselt eine Box (oder eine ganze Gruppe) auf AUX, wird eine Zone aufgelöst und ein Stereopaar aufgehoben. Jede Box nutzt ihren eigenen AUX-Eingang, damit nichts asynchron läuft.
- Stereopaar: statt AUX/BT/Aus nur noch ein Ein/Aus-Knopf mit Symbol (grau = aus, orange = an).
- Spielt eine Gruppe, zeigen die Einzelboxen darin keinen Titel und kein Cover mehr, sondern eine orange Note ♪ nach dem Namen.
- Umziehen: Die Ziel-Box wird schon geweckt, sobald Umziehen aufgeklappt oder das Ziel gewählt wird (nur wenn die Quelle spielt).

## 0.16.8
- Umziehen mit Music Assistant: `player_queues/transfer` wartet bis zu 30 s (vorher 8 s). Laut Diagnose lief der Umzug trotz „timeout"-Meldung durch; die App brach ab und schaltete die Quell-Box nicht aus. Ein Timeout gilt jetzt nicht mehr als Fehler, die App prüft danach, ob es auf der Ziel-Box läuft.
- Nach dem Aufwecken wartet die App bis zu 15 s, bis Music Assistant die Ziel-Box wieder als Player sieht (vorher 8 s).

## 0.16.7
- Diagnose beim Umziehen: zeigt, ob der Umzug über Music Assistant oder als Box-Kopie lief (die Kopie hängt am Stream der Quell-Box), und die Zonengröße von Quelle und Ziel vorher/nachher.

## 0.16.6
- Umziehen mit Music Assistant: Läuft die Musik auf der Ziel-Box nach der Übertragung nicht an (frisch geweckte Box, Quelle „INVALID_SOURCE"), startet die App sie bis zu zweimal neu (`player_queues/resume`). Klappt es nicht, wird die Musik auf die Quelle zurückgelegt, statt verloren zu gehen. Nach dem Wecken der Ziel-Box 2 s Pause.
- Die Diagnose behält die letzten 20 statt 8 Einträge, damit ein Umzug nicht von späteren Tasten verdrängt wird.

## 0.16.5
- Play nach Pause über Music Assistant geht gleich per `player_queues/resume`. Die Diagnose zeigte: `play_pause` meldet bei den UPnP-Boxen „ok", setzt aber nicht fort; die Wartezeit war verschenkt. `play_pause` bleibt als Rückfall, falls resume fehlschlägt.
- Die Diagnose zeigt bei den Schritten jetzt die Dauer in Millisekunden.

## 0.16.4
- Play nach Pause über Music Assistant: Laut MA-Quelltext wartet `play_pause` bis zu 5 s auf die Bestätigung der Box, die App brach nach 4 s ab und kam nie zum Nachhelfen. Jetzt 8 s Wartezeit, ein Fehler dort bricht nicht mehr ab, danach `player_queues/resume`. Der nicht belegte Befehl `player_queues/play` ist raus.

## 0.16.3
- Umziehen bei laufendem Music Assistant: MA überträgt die Warteschlange selbst auf die Ziel-Box (`player_queues/transfer`), statt die Box-Quelle zu kopieren. Auch wenn die Quell-Box dabei als „aus“ gemeldet wird.
- Die Diagnose zeigt unter „Letzte Player-Tasten“ jetzt auch die letzten Umzüge mit Schritten.

## 0.16.2
- Diagnose zeigt jetzt die letzten Player-Tasten: ob die Taste an Music Assistant oder an die Box ging, warum (Quelle, Titel, Zustand der MA-Warteschlange) und was MA geantwortet hat. Für die Suche, warum Weiterspielen/Weiter/Zurück bei Music Assistant nicht sauber laufen.

## 0.16.1
- **Weiterspielen nach Pause über Music Assistant:** Pause ging, Weiterspielen nicht. Zwei mögliche Ursachen sind behoben: (1) Über AirPlay meldet die Box im Pausenzustand oft keinen Titel; dann galt Music Assistant nicht mehr als Quelle und die Taste ging an die Box. Jetzt gilt die MA-Warteschlange, solange sie läuft oder pausiert und kein anderer Titel gemeldet wird. (2) `play_pause` setzt bei manchen Playern nicht fort: die App prüft nach und schickt dann `play`, danach `resume`. Nicht an echter Hardware geprüft.
- MIT-Lizenz (`LICENSE`).

## 0.16.0
- **Zwei Sprachen:** Deutsch und Englisch. Standard folgt der Systemsprache des Geräts (andere Sprachen → Englisch); umschaltbar unter ⚙ Einstellungen → Sprache, wirkt sofort. Alle Texte stehen in `www/i18n.js`; ein Test prüft, dass beide Sprachen vollständig sind.
- **Keine Vorgaben mehr:** keine voreingetragenen Boxen und keine Standardgruppe; Platzhalter-Adressen sind neutral (192.168.1.x). Der alte Server-Ordner `server/` (Version 0.1) ist entfernt. Die Übernahme der Version-0.2-Einstellungen entfällt.
- Neuer Test `test/hygiene.test.mjs` bricht ab, wenn Persönliches (Namen, eigene Heimnetz-Adressen, Schlüssel) in versionierten Dateien steht; CI führt ihn und den Übersetzungstest aus.
- Quelltextprüfung (QK): Android-Cloud-Backup abgeschaltet (der Music-Assistant-Token läge sonst im Backup); pro Aktualisierung wird jede Box nur noch einmal abgefragt (vorher zweimal, wenn Music Assistant eingerichtet war). Speicherschlüssel heißen jetzt `finglongerer.*`.
- README zweisprachig.

## 0.15.1
- App-ID geändert auf `de.krichel.finglongerer` (Android-Paket, Namespace, Capacitor). Das ist eine neue App neben der alten: die alte Installation (`de.krichel.steasyremote`) deinstallieren und neu einrichten, Boxen und Einstellungen neu eintragen. Repository heißt jetzt `Finglongerer`.

## 0.15.0
- App heißt jetzt **Finglongerer** (Name unter dem Icon, Titel, Kopfzeile, APK-Dateiname `Finglongerer-<Version>.apk`). Die App-ID bleibt, Updates laufen weiter über die alte Installation.

## 0.14.1
- Music Assistant streamt zu den Boxen per AirPlay (Diagnose: Quelle `AIRPLAY`, Cover von der Box). Bisher galt AirPlay nie als MA, daher gingen Weiter/Zurück/Pause trotzdem an die Box. Jetzt gilt MA bei AirPlay als aktiv, wenn der Titel der Box zum Titel der MA-Warteschlange passt; AirPlay vom Handy mit anderem Titel bleibt bei den Box-Tasten.

## 0.14.0
- Alle Angaben zum laufenden Titel stehen mehrzeilig untereinander (Titel, Interpret(en), Album, Sender), nichts wird mehr abgeschnitten. Bei Music Assistant werden alle Interpreten gezeigt.
- Cover: links neben dem Text, aus dem `<art>`-Feld der Box (kam im Test von der Jellyfin-DLNA-Wiedergabe) bzw. bei MA aus dem Bild des Titels. Fehlt oder scheitert das Bild, entfällt es still.
- Music Assistant gilt nur noch als „aktiv", wenn die Stream-Adresse der Box auf den MA-Server (Port 8095/8097) zeigt. Spielt die Box direkt von Jellyfin-DLNA (Port 8096, gleiche IP wie MA), gehen die Tasten wieder an die Box, auch wenn eine alte MA-Warteschlange noch „pausiert" zeigt. Ohne IP in der Adresse entscheidet weiter die Quelle.
- Diagnose schwärzt `api_key=`/`token=` in den Texten (die MA-Antworten enthielten Jellyfin-Schlüssel).

## 0.13.1
- Einstellungen → Diagnose: „Antworten der Boxen zeigen" listet je Box die Rohantwort von `/now_playing` (Titel, Cover-Feld, Quelle) und, wenn Music Assistant verbunden ist, den Warteschlangen-Eintrag des zugeordneten Players; „Kopieren" legt den Text in die Zwischenablage. Der MA-Token steht nie darin.

## 0.13.0
- Music Assistant steuert Weiter/Zurück/Play-Pause selbst: Spielt MA auf einer Box, gehen die Player-Tasten per `POST /api` (`player_queues/next`, `/previous`, `/play_pause`) an MA statt an die Box (deren Tasten melden dort „Invalid Source"; Fortsetzen ging nicht). Bei Gruppen zählt die Master-Box. Titel und Interpret in der Titelzeile kommen dann ebenfalls von MA.
- Einstellungen: neues Feld „Token" (langlebiger Token aus dem MA-Profil) und „Verbindung testen": zeigt je Box den zugeordneten MA-Player, den Zustand der Warteschlange und die Quelle der Box (als Diagnose).
- Ob MA „aktiv" ist, schätzt die App: MA-Warteschlange läuft/pausiert und die Box steht nicht auf AUX, Bluetooth, Radio, Spotify oder Standby (oder ihre Stream-Adresse zeigt auf den MA-Server). Ohne erreichbares MA bleibt alles wie in 0.12.0; ein nicht erreichbares MA bremst die Anzeige höchstens einmal je 15 s.
- Nicht verifiziert gegen ein echtes MA: Antwortformen von `players/all` und `player_queues/all` (tolerant gelesen) und ob `play_pause` das Fortsetzen auf der Box bewirkt.

## 0.12.0
- Music Assistant: Adresse in den Einstellungen (leer lassen = kein Knopf). „Music Assistant suchen" prüft im Heimnetz Port 8095 (`/info`, sonst Startseite); Handeingabe geht ebenfalls. Auf der Hauptseite öffnet „Music Assistant öffnen" dessen Weboberfläche im Browser (Login dort). Die Autoerkennung stützt sich auf `/info` ohne Anmeldung; ob MA das bei deiner Version so liefert, ist nicht verifiziert (Handeingabe bleibt der Ausweg). Direkte Steuerung über die MA-API ist noch nicht gebaut.

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
