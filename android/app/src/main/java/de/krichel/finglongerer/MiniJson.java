package de.krichel.finglongerer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Kleiner JSON-Leser (Objekte, Listen, Texte, Zahlen, true/false/null) für die Chromecast-Nachrichten; reines Java. */
final class MiniJson {
    private final String s;
    private int p;

    private MiniJson(String s) { this.s = s; }

    /** Liest einen JSON-Text; wirft IllegalArgumentException bei Fehlern. */
    static Object parse(String text) {
        MiniJson j = new MiniJson(text == null ? "" : text);
        Object v = j.value(0);
        j.ws();
        if (j.p != j.s.length()) throw new IllegalArgumentException("JSON: Rest nach dem Ende");
        return v;
    }

    private void ws() {
        while (p < s.length() && " \t\r\n".indexOf(s.charAt(p)) >= 0) p++;
    }

    private char peek() {
        if (p >= s.length()) throw new IllegalArgumentException("JSON: zu kurz");
        return s.charAt(p);
    }

    private Object value(int depth) {
        if (depth > 40) throw new IllegalArgumentException("JSON: zu tief");
        ws();
        char c = peek();
        if (c == '{') {
            p++;
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            ws();
            if (peek() == '}') { p++; return m; }
            while (true) {
                ws();
                String k = string();
                ws();
                if (peek() != ':') throw new IllegalArgumentException("JSON: ':' fehlt");
                p++;
                m.put(k, value(depth + 1));
                ws();
                char d = peek(); p++;
                if (d == '}') return m;
                if (d != ',') throw new IllegalArgumentException("JSON: ',' fehlt");
            }
        }
        if (c == '[') {
            p++;
            List<Object> l = new ArrayList<Object>();
            ws();
            if (peek() == ']') { p++; return l; }
            while (true) {
                l.add(value(depth + 1));
                ws();
                char d = peek(); p++;
                if (d == ']') return l;
                if (d != ',') throw new IllegalArgumentException("JSON: ',' fehlt");
            }
        }
        if (c == '"') return string();
        if (s.startsWith("true", p)) { p += 4; return Boolean.TRUE; }
        if (s.startsWith("false", p)) { p += 5; return Boolean.FALSE; }
        if (s.startsWith("null", p)) { p += 4; return null; }
        int st = p;
        while (p < s.length() && "+-0123456789.eE".indexOf(s.charAt(p)) >= 0) p++;
        if (st == p) throw new IllegalArgumentException("JSON: unerwartetes Zeichen");
        return Double.valueOf(s.substring(st, p));
    }

    private String string() {
        if (peek() != '"') throw new IllegalArgumentException("JSON: Text erwartet");
        p++;
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = peek(); p++;
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = peek(); p++;
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u':
                    if (p + 4 > s.length()) throw new IllegalArgumentException("JSON: \\u kaputt");
                    b.append((char) Integer.parseInt(s.substring(p, p + 4), 16)); p += 4;
                    break;
                default: b.append(e);
            }
        }
    }

    /** Text als JSON-Zeichenkette mit Anführungszeichen. */
    static String quote(String v) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c == '\t') b.append("\\t");
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> obj(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : Collections.<String, Object>emptyMap();
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return o instanceof List ? (List<Object>) o : Collections.<Object>emptyList();
    }

    static String str(Map<String, Object> m, String k) {
        Object v = m.get(k);
        return v instanceof String ? (String) v : "";
    }

    static double num(Map<String, Object> m, String k, double def) {
        Object v = m.get(k);
        return v instanceof Double ? (Double) v : def;
    }

    static boolean bool(Map<String, Object> m, String k) {
        return Boolean.TRUE.equals(m.get(k));
    }
}
