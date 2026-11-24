package de.krichel.finglongerer;
/** Prüft CastLink gegen test/mock_cast.py (Aufruf über test/cast.test.mjs). */
public class CastLinkTest {
    static void eq(String what, Object a, Object b) { if (!String.valueOf(a).equals(String.valueOf(b))) { System.out.println("FEHLER " + what + ": " + a + " != " + b); System.exit(1); } System.out.println("ok " + what); }
    public static void main(String[] x) throws Exception {
        CastLink.port = Integer.parseInt(x[0]);
        // Protobuf + JSON
        StringBuilder big = new StringBuilder(); for (int i = 0; i < 300; i++) big.append("ä\"x");
        CastLink.Msg m = CastLink.decode(CastLink.encode("a", "b", "ns", big.toString()));
        eq("protobuf lang", m.payload.equals(big.toString()) && m.src.equals("a") && m.dst.equals("b") && m.ns.equals("ns"), true);
        eq("json", MiniJson.str(MiniJson.obj(MiniJson.parse(" {\"a\":[1,{\"b\":\"\\u00e4\\n\"}],\"c\":true} ")), "c"), "");
        eq("json quote", MiniJson.quote("a\"b\\c\n\u0001"), "\"a\\\"b\\\\c\\n\\u0001\"");
        String ip = "127.0.0.1";
        String st = CastLink.status(ip); System.out.println(st);
        Object j = MiniJson.parse(st); java.util.Map<String,Object> o = MiniJson.obj(j);
        eq("lautstaerke", MiniJson.num(o, "volume", -1), 0.4); eq("state", MiniJson.str(o, "state"), "PLAYING"); eq("titel", MiniJson.str(o, "title"), "Titel 1 ü");
        eq("app", MiniJson.str(o, "app"), "Spotify ä \"Test\"");
        o = MiniJson.obj(MiniJson.parse(CastLink.volume(ip, 0.75, -1))); eq("volume gesetzt", MiniJson.num(o, "volume", -1), 0.75);
        o = MiniJson.obj(MiniJson.parse(CastLink.volume(ip, 0, 1))); eq("stumm", MiniJson.bool(o, "muted"), true);
        o = MiniJson.obj(MiniJson.parse(CastLink.volume(ip, 0, 0))); eq("nicht stumm", MiniJson.bool(o, "muted"), false);
        o = MiniJson.obj(MiniJson.parse(CastLink.media(ip, "PAUSE"))); eq("pause", MiniJson.str(o, "state"), "PAUSED");
        o = MiniJson.obj(MiniJson.parse(CastLink.media(ip, "PLAY"))); eq("play", MiniJson.str(o, "state"), "PLAYING");
        o = MiniJson.obj(MiniJson.parse(CastLink.media(ip, "NEXT"))); eq("weiter", MiniJson.str(o, "title"), "Titel 2 ü");
        try { CastLink.media(ip, "PREV"); eq("zurück-Fehler", "kein Fehler", "Fehler"); } catch (java.io.IOException e) { eq("zurück-Fehler", e.getMessage(), "CAST:INVALID_COMMAND"); }
        o = MiniJson.obj(MiniJson.parse(CastLink.stop(ip))); eq("stop", o.containsKey("app"), false);
        try { CastLink.media(ip, "PLAY"); eq("ohne App", "kein Fehler", "Fehler"); } catch (java.io.IOException e) { eq("ohne App", e.getMessage(), "CAST:Nichts aktiv"); }
        eq("name", CastLink.httpName(ip, CastLink.port + 1), "Küche");
        eq("lan", CastLink.lanIp("192.168.1.5") && !CastLink.lanIp("8.8.8.8") && !CastLink.lanIp("192.168.1.5; x"), true);
        System.out.println("ALLES OK");
    }
}
