import java.net.URLDecoder;
import java.util.regex.Pattern;
import javax.servlet.http.HttpServletRequest;
import org.apache.commons.csv.CSVPrinter;
import org.commonmark.renderer.html.HtmlRenderer;
import net.spy.memcached.MemcachedClient;

class Encoding {
    boolean search(HttpServletRequest req) {
        String q = req.getParameter("q");
        Pattern pattern = Pattern.compile(q);
        return pattern.matcher("catalog").find();
    }

    boolean validateSlug(String slug) {
        return Pattern.compile("^(a+)+$").matcher(slug).matches();
    }

    String greet(HttpServletRequest req) {
        String template = req.getParameter("template");
        return String.format(template, "guest");
    }

    void export(HttpServletRequest req, CSVPrinter printer) throws Exception {
        String name = req.getParameter("name");
        printer.printRecord("customer", name);
    }

    Object cached(HttpServletRequest req, MemcachedClient cache) {
        String id = req.getParameter("id");
        return cache.get(id);
    }

    String decodeTwice(String raw) throws Exception {
        String first = URLDecoder.decode(raw, "UTF-8");
        String second = URLDecoder.decode(first, "UTF-8");
        return second;
    }

    String link(HttpServletRequest req) {
        String term = req.getParameter("term");
        return "https://search.example.com/find?q=" + term;
    }

    String payload(HttpServletRequest req) {
        String name = req.getParameter("name");
        return "{\"name\":\"" + name + "\"}";
    }

    HtmlRenderer renderer() {
        return HtmlRenderer.builder().build();
    }

    HtmlRenderer configuredRenderer() {
        return HtmlRenderer.builder().escapeHtml(false).build();
    }
}
