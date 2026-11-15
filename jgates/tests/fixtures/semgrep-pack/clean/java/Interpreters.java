import java.io.File;
import java.io.StringReader;
import javax.naming.Context;
import javax.naming.directory.DirContext;
import javax.naming.directory.SearchControls;
import javax.script.ScriptEngine;
import javax.servlet.http.HttpServletRequest;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.stream.StreamSource;
import javax.xml.xpath.XPath;

class Interpreters {
    Object findUser(HttpServletRequest request, DirContext ctx, SearchControls controls) throws Exception {
        String uid = request.getParameter("uid");
        return ctx.search("ou=people,dc=example,dc=com", "(uid={0})", new Object[] {uid}, controls);
    }

    Object findAccount(HttpServletRequest request, XPath xpath, Object accounts) throws Exception {
        String id = request.getParameter("id");
        xpath.setXPathVariableResolver(new MapResolver(id));
        return xpath.evaluate("//account[@id=$id]", accounts);
    }

    void renderPage(HttpServletRequest request, Handlebars handlebars) throws Exception {
        String name = request.getParameter("name");
        handlebars.compile("page").apply(name);
    }

    Object calculate(ScriptEngine engine) throws Exception {
        return engine.eval("1 + 1");
    }

    Object dataSource(Context ctx) throws Exception {
        return ctx.lookup("java:comp/env/jdbc/app");
    }

    void applyStylesheet(TransformerFactory factory) throws Exception {
        factory.newTransformer(new StreamSource(new File("report.xsl")));
    }

    void buildPdf(String file) throws Exception {
        new ProcessBuilder("pdflatex", "-no-shell-escape", file).start();
    }
}
