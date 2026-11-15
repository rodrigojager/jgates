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
        return ctx.search("ou=people,dc=example,dc=com", "(uid=" + uid + ")", controls);
    }

    Object findAccount(HttpServletRequest request, XPath xpath, Object accounts) throws Exception {
        String id = request.getParameter("id");
        return xpath.evaluate("//account[@id='" + id + "']", accounts);
    }

    void renderPage(HttpServletRequest request, Handlebars handlebars) throws Exception {
        String source = request.getParameter("page");
        handlebars.compileInline(source);
    }

    Object calculate(ScriptEngine engine, String formula) throws Exception {
        return engine.eval(formula);
    }

    Object dataSource(Context ctx, String name) throws Exception {
        return ctx.lookup(name);
    }

    void applyStylesheet(HttpServletRequest request, TransformerFactory factory) throws Exception {
        String stylesheet = request.getParameter("xsl");
        factory.newTransformer(new StreamSource(new StringReader(stylesheet)));
    }

    void buildPdf(String file) throws Exception {
        new ProcessBuilder("pdflatex", "-shell-escape", file).start();
    }
}
