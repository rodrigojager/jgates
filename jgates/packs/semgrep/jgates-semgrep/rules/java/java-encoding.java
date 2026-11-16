import java.io.PrintWriter;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.text.MessageFormat;
import java.util.Locale;
import org.json.JSONObject;
import java.util.Base64;
import java.util.regex.Pattern;
import javax.servlet.http.HttpServletRequest;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.csv.CSVPrinter;
import org.apache.commons.text.StringEscapeUtils;
import org.apache.poi.ss.usermodel.Cell;
import com.opencsv.CSVWriter;
import com.fasterxml.jackson.databind.ObjectMapper;
import net.spy.memcached.MemcachedClient;
import org.commonmark.renderer.html.HtmlRenderer;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.util.HtmlUtils;

class EncodingFixture {
    static String sanitizeCsvField(String value) { return value; }
    static String validateCacheKey(String value) { return value; }

    // ---- regex-from-request ----
    boolean regexServlet(HttpServletRequest req, String text) {
        String q = req.getParameter("q");
        // ruleid: jgates.java.regex-from-request
        Pattern p = Pattern.compile(q);
        // ruleid: jgates.java.regex-from-request
        boolean m = text.matches(req.getParameter("pattern"));
        // ok: jgates.java.regex-from-request
        Pattern quoted = Pattern.compile(Pattern.quote(q));
        // ok: jgates.java.regex-from-request
        Pattern anchored = Pattern.compile("^" + Pattern.quote(q) + "$");
        // ok: jgates.java.regex-from-request
        Pattern fixed = Pattern.compile("[a-z]+");
        // ok: jgates.java.regex-from-request
        return text.contains(q);
    }

    String regexSpring(@RequestParam("find") String find, String text) {
        // ruleid: jgates.java.regex-from-request
        String a = text.replaceAll(find, "");
        // ruleid: jgates.java.regex-from-request
        String[] parts = text.split(find);
        // ok: jgates.java.regex-from-request
        return text.replaceAll(Pattern.quote(find), "");
    }

    // ---- redos-nested-quantifier ----
    void redos(String input) {
        // ruleid: jgates.java.redos-nested-quantifier
        Pattern a = Pattern.compile("^(a+)+$");
        // ruleid: jgates.java.redos-nested-quantifier
        boolean b = input.matches("(\\w+\\s*)*end");
        // ruleid: jgates.java.redos-nested-quantifier
        Pattern c = Pattern.compile("([a-z]*)*x");
        // ok: jgates.java.redos-nested-quantifier
        Pattern d = Pattern.compile("^a+$");
        // ok: jgates.java.redos-nested-quantifier
        boolean e = input.matches("(ab)+c");
        // ok: jgates.java.redos-nested-quantifier
        Pattern f = Pattern.compile("(\\w+\\+)+");
        // ok: jgates.java.redos-nested-quantifier
        Pattern g = Pattern.compile("^[a-z]+(-[a-z]+)?$");
    }

    // ---- format-string-from-request ----
    void formatServlet(HttpServletRequest req, PrintWriter out) {
        String fmt = req.getParameter("fmt");
        // ruleid: jgates.java.format-string-from-request
        String s = String.format(fmt, 1);
        // ruleid: jgates.java.format-string-from-request
        System.out.printf(req.getHeader("X-Format"), 2);
        // ruleid: jgates.java.format-string-from-request
        String t = MessageFormat.format(fmt, "x");
        // ruleid: jgates.java.format-string-from-request
        String u = String.format(Locale.ROOT, fmt, 1);
        // ok: jgates.java.format-string-from-request
        String loc = String.format(Locale.ROOT, "%s", fmt);
        // ok: jgates.java.format-string-from-request
        String safe = String.format("%s", fmt);
        // ok: jgates.java.format-string-from-request
        System.out.printf("value: %s%n", req.getParameter("v"));
        // ok: jgates.java.format-string-from-request
        String constant = String.format("%d items", 3);
    }

    void formatSpring(@RequestParam String template) {
        // ruleid: jgates.java.format-string-from-request
        String s = template.formatted(1);
        // ok: jgates.java.format-string-from-request
        String safe = "%s".formatted(template);
    }

    // ---- csv-formula-injection ----
    void csvServlet(HttpServletRequest req, CSVPrinter printer, CSVWriter writer, Cell cell) throws Exception {
        String name = req.getParameter("name");
        // ruleid: jgates.java.csv-formula-injection
        printer.printRecord("id", name);
        // ruleid: jgates.java.csv-formula-injection
        writer.writeNext(new String[] {"id", name});
        // ruleid: jgates.java.csv-formula-injection
        cell.setCellValue(req.getParameter("note"));
        // ok: jgates.java.csv-formula-injection
        printer.printRecord("id", sanitizeCsvField(name));
        // ok: jgates.java.csv-formula-injection
        writer.writeNext(new String[] {"id", sanitizeCsvField(name)});
        // ok: jgates.java.csv-formula-injection
        cell.setCellValue("fixed");
    }

    // ---- memcache-key-from-request ----
    void memcacheServlet(HttpServletRequest req, MemcachedClient cache) {
        String id = req.getParameter("id");
        // ruleid: jgates.java.memcache-key-from-request
        Object v = cache.get(id);
        // ruleid: jgates.java.memcache-key-from-request
        cache.set("user:" + id, 300, "value");
        // ok: jgates.java.memcache-key-from-request
        Object hashed = cache.get(DigestUtils.sha256Hex(id));
        // ok: jgates.java.memcache-key-from-request
        cache.set(validateCacheKey(id), 300, "value");
        // ok: jgates.java.memcache-key-from-request
        Object fixed = cache.get("site:config");
    }

    // ---- double-decoding ----
    void doubleDecode(String raw) throws Exception {
        // ruleid: jgates.java.double-decoding
        String once = URLDecoder.decode(URLDecoder.decode(raw, "UTF-8"), "UTF-8");
        // ruleid: jgates.java.double-decoding
        String first = URLDecoder.decode(raw, "UTF-8");
        String second = URLDecoder.decode(first, "UTF-8");
        // ruleid: jgates.java.double-decoding
        String h = StringEscapeUtils.unescapeHtml4(StringEscapeUtils.unescapeHtml4(raw));
        // ruleid: jgates.java.double-decoding
        String x = HtmlUtils.htmlUnescape(HtmlUtils.htmlUnescape(raw));
        // ruleid: jgates.java.double-decoding
        byte[] b = Base64.getDecoder().decode(new String(Base64.getDecoder().decode(raw)));
        // ok: jgates.java.double-decoding
        String single = URLDecoder.decode(raw, "UTF-8");
        // ok: jgates.java.double-decoding
        String mixed = StringEscapeUtils.unescapeHtml4(URLDecoder.decode(raw, "UTF-8"));
        // ok: jgates.java.double-decoding
        byte[] decoded = Base64.getDecoder().decode(raw);
    }

    // ---- url-parameter-unencoded ----
    String urlServlet(HttpServletRequest req) throws Exception {
        String q = req.getParameter("q");
        // ruleid: jgates.java.url-parameter-unencoded
        String a = "https://search.example.com/find?q=" + q;
        // ruleid: jgates.java.url-parameter-unencoded
        String b = String.format("https://search.example.com/find?q=%s", q);
        // ruleid: jgates.java.url-parameter-unencoded
        String c = "https://api.example.com/users/" + req.getParameter("id");
        // ok: jgates.java.url-parameter-unencoded
        String d = "https://search.example.com/find?q=" + URLEncoder.encode(q, "UTF-8");
        // ok: jgates.java.url-parameter-unencoded
        String e = String.format("https://search.example.com/find?q=%s", URLEncoder.encode(q, "UTF-8"));
        // ok: jgates.java.url-parameter-unencoded
        return "https://search.example.com/find?q=fixed";
    }

    String urlSpring(@PathVariable String id) {
        // ruleid: jgates.java.url-parameter-unencoded
        return "https://api.example.com/items/" + id;
    }

    // ---- json-built-by-concatenation ----
    String jsonServlet(HttpServletRequest req, ObjectMapper mapper) throws Exception {
        String name = req.getParameter("name");
        // ruleid: jgates.java.json-built-by-concatenation
        String a = "{\"name\":\"" + name + "\"}";
        // ruleid: jgates.java.json-built-by-concatenation
        String b = String.format("{\"name\":\"%s\"}", name);
        // ruleid: jgates.java.json-built-by-concatenation
        String c = "<script>var user = " + req.getParameter("u") + ";</script>";
        // ok: jgates.java.json-built-by-concatenation
        String d = mapper.writeValueAsString(java.util.Map.of("name", name));
        // ok: jgates.java.json-built-by-concatenation
        String e = "{\"name\":\"" + StringEscapeUtils.escapeJson(name) + "\"}";
        // ok: jgates.java.json-built-by-concatenation
        String f = "{\"name\":" + JSONObject.quote(name) + "}";
        // ok: jgates.java.json-built-by-concatenation
        String g = new com.google.gson.Gson().toJson(name);
        // ok: jgates.java.json-built-by-concatenation
        return "{\"status\":\"ok\"}";
    }

    // ---- markdown-raw-html-enabled ----
    void markdown() {
        // ruleid: jgates.java.markdown-raw-html-enabled-by-default
        HtmlRenderer a = HtmlRenderer.builder().build();
        // ruleid: jgates.java.markdown-raw-html-enabled
        HtmlRenderer b = HtmlRenderer.builder().escapeHtml(false).build();
        // ruleid: jgates.java.markdown-raw-html-enabled-by-default
        HtmlRenderer c = HtmlRenderer.builder().extensions(java.util.List.of()).build();
        // ok: jgates.java.markdown-raw-html-enabled
        HtmlRenderer d = HtmlRenderer.builder().escapeHtml(true).build();
        // ok: jgates.java.markdown-raw-html-enabled
        HtmlRenderer e = HtmlRenderer.builder().extensions(java.util.List.of()).escapeHtml(true).build();
        // ok: jgates.java.markdown-raw-html-enabled-by-default
        HtmlRenderer safeDefault = HtmlRenderer.builder().escapeHtml(true).build();
        // ok: jgates.java.markdown-raw-html-enabled-by-default
        HtmlRenderer safeExtensions = HtmlRenderer.builder().extensions(java.util.List.of()).escapeHtml(true).build();
        // ruleid: jgates.java.markdown-raw-html-enabled
        HtmlRenderer f = HtmlRenderer.builder().extensions(java.util.List.of()).escapeHtml(false).build();
    }

}
