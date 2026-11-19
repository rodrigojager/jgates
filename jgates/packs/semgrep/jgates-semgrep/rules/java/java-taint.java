import java.io.File;
import java.io.FileInputStream;
import java.io.ObjectInputStream;
import java.io.PrintWriter;
import java.net.URL;
import java.nio.file.Path;
import java.nio.file.Paths;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.io.FilenameUtils;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.HtmlUtils;

class TaintFixture {
    static String validateUrl(String url) { return url; }

    void ssrfServlet(HttpServletRequest req) throws Exception {
        String target = req.getParameter("url");
        // ruleid: jgates.java.ssrf
        new URL(target).openConnection();
        // ok: jgates.java.ssrf
        new URL("https://api.example.com/status").openConnection();
        // ok: jgates.java.ssrf
        new URL(validateUrl(req.getParameter("url"))).openConnection();
    }

    String ssrfSpring(@RequestParam("callback") String callback, @RequestParam String other, RestTemplate rest) {
        // ruleid: jgates.java.ssrf
        rest.getForObject(callback, String.class);
        // ruleid: jgates.java.ssrf
        rest.postForObject(other, "body", String.class);
        // ok: jgates.java.ssrf
        rest.getForObject("https://api.example.com/status", String.class);
        // ok: jgates.java.ssrf
        return rest.getForObject(validateUrl(callback), String.class);
    }

    void pathServlet(HttpServletRequest req) throws Exception {
        String name = req.getParameter("file");
        // ruleid: jgates.java.path-traversal
        new FileInputStream(new File("/srv/data", name));
        // ruleid: jgates.java.path-traversal
        Path p = Paths.get("/srv/data", name);
        // ok: jgates.java.path-traversal
        new FileInputStream(new File("/srv/data", FilenameUtils.getName(name)));
        // ok: jgates.java.path-traversal
        new FileInputStream(new File("/srv/data/readme.txt"));
    }

    byte[] pathSpring(@PathVariable String name) throws Exception {
        // ruleid: jgates.java.path-traversal
        File f = new File(name);
        // ok: jgates.java.path-traversal
        File safe = new File(FilenameUtils.getName(name));
        return new byte[0];
    }

    void xssServlet(HttpServletRequest req, HttpServletResponse resp) throws Exception {
        String name = req.getParameter("name");
        // ruleid: jgates.java.reflected-xss
        resp.getWriter().println("<p>Hello " + name + "</p>");
        // ruleid: jgates.java.reflected-xss
        resp.getWriter().write(req.getParameter("q"));
        // ok: jgates.java.reflected-xss
        resp.getWriter().println("<p>Hello " + HtmlUtils.htmlEscape(name) + "</p>");
        // ok: jgates.java.reflected-xss
        resp.getWriter().println("<p>Static page</p>");
    }

    void xssWriter(HttpServletRequest req, HttpServletResponse resp) throws Exception {
        PrintWriter out = resp.getWriter();
        // ruleid: jgates.java.reflected-xss
        out.println(req.getHeader("User-Agent"));
        // ok: jgates.java.reflected-xss
        out.println(HtmlUtils.htmlEscape(req.getHeader("User-Agent")));
    }

    @GetMapping(value = "/hello", produces = "text/html")
    String xssSpring(@RequestParam String name) {
        // ruleid: jgates.java.reflected-xss
        return "<h1>Hello " + name + "</h1>";
    }

    @GetMapping(value = "/safe", produces = "text/html")
    String xssSpringSafe(@RequestParam String name) {
        // ok: jgates.java.reflected-xss
        return "<h1>Hello " + HtmlUtils.htmlEscape(name) + "</h1>";
    }

    Object deserializeServlet(HttpServletRequest req) throws Exception {
        // ruleid: jgates.java.unsafe-deserialization
        ObjectInputStream in = new ObjectInputStream(req.getInputStream());
        return in.readObject();
    }

    Object deserializeSpring(@RequestBody byte[] body) throws Exception {
        // ruleid: jgates.java.unsafe-deserialization
        return new ObjectInputStream(new java.io.ByteArrayInputStream(body)).readObject();
    }

    Object deserializeLocal() throws Exception {
        // ok: jgates.java.unsafe-deserialization
        return new ObjectInputStream(new FileInputStream("cache.bin")).readObject();
    }

    Object deserializeSafeFormat(HttpServletRequest req) throws Exception {
        // ok: jgates.java.unsafe-deserialization
        return new com.fasterxml.jackson.databind.ObjectMapper().readValue(req.getInputStream(), java.util.Map.class);
    }
}
