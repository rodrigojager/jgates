import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.regex.Pattern;
import javax.servlet.http.HttpServletRequest;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.csv.CSVPrinter;
import org.commonmark.renderer.html.HtmlRenderer;
import com.fasterxml.jackson.databind.ObjectMapper;
import net.spy.memcached.MemcachedClient;

class Encoding {
    static String sanitizeCsvField(String value) {
        if (!value.isEmpty() && "=+-@".indexOf(value.charAt(0)) >= 0) {
            return "'" + value;
        }
        return value;
    }

    boolean search(HttpServletRequest req) {
        String q = req.getParameter("q");
        Pattern pattern = Pattern.compile(Pattern.quote(q));
        return pattern.matcher("catalog").find();
    }

    boolean validateSlug(String slug) {
        return Pattern.compile("^a+$").matcher(slug).matches();
    }

    String greet(HttpServletRequest req) {
        String template = req.getParameter("template");
        return String.format("%s: %s", "guest", template);
    }

    void export(HttpServletRequest req, CSVPrinter printer) throws Exception {
        String name = req.getParameter("name");
        printer.printRecord("customer", sanitizeCsvField(name));
    }

    Object cached(HttpServletRequest req, MemcachedClient cache) {
        String id = req.getParameter("id");
        return cache.get(DigestUtils.sha256Hex(id));
    }

    String decodeOnce(String raw) throws Exception {
        return URLDecoder.decode(raw, "UTF-8");
    }

    String link(HttpServletRequest req) throws Exception {
        String term = req.getParameter("term");
        return "https://search.example.com/find?q=" + URLEncoder.encode(term, "UTF-8");
    }

    String payload(HttpServletRequest req, ObjectMapper mapper) throws Exception {
        String name = req.getParameter("name");
        return mapper.writeValueAsString(java.util.Map.of("name", name));
    }

    HtmlRenderer renderer() {
        return HtmlRenderer.builder().escapeHtml(true).build();
    }

    HtmlRenderer configuredRenderer() {
        return HtmlRenderer.builder().escapeHtml(true).build();
    }
}
