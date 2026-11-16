import javax.servlet.http.HttpServletRequest;
import javax.naming.Context;
import javax.naming.InitialContext;
import javax.naming.directory.DirContext;
import javax.naming.directory.SearchControls;
import javax.naming.ldap.LdapName;
import javax.naming.ldap.Rdn;
import javax.script.ScriptEngine;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.stream.StreamSource;
import javax.xml.xpath.XPath;
import java.io.File;
import java.io.StringReader;
import java.util.List;
import jakarta.mail.Message;
import jakarta.mail.internet.MimeMessage;

class InterpretersFixture {
    void mailHeaders(HttpServletRequest req, MimeMessage message, Message generic) throws Exception {
        String subject = req.getParameter("subject");
        // ruleid: jgates.java.mail-header-injection
        message.setHeader("Subject", subject);
        // ruleid: jgates.java.mail-header-injection
        generic.addHeader("Reply-To", req.getHeader("X-Reply-To"));
        // ok: jgates.java.mail-header-injection
        message.setHeader("Subject", subject.replace('\r', ' ').replace('\n', ' '));
        // ok: jgates.java.mail-header-injection
        generic.addHeader("Reply-To", req.getHeader("X-Reply-To").replace('\r', ' ').replace('\n', ' '));
        // ok: jgates.java.mail-header-injection
        message.setHeader("Subject", "Account notification");
        // ok: jgates.java.mail-header-injection
        message.setSubject(subject);
        // ok: jgates.java.mail-header-injection
        message.setText(req.getParameter("body"));
    }

    void ldap(HttpServletRequest req, DirContext ctx, LdapTemplate template, SearchControls controls) throws Exception {
        String user = req.getParameter("user");
        // ruleid: jgates.java.ldap-injection
        ctx.search("ou=people,dc=example,dc=com", "(uid=" + user + ")", controls);
        // ruleid: jgates.java.ldap-injection
        ctx.search("ou=" + user + ",dc=example,dc=com", "(objectClass=person)", controls);
        // ruleid: jgates.java.ldap-injection
        template.search("ou=people", "(&(uid=" + user + ")(active=true))", mapper);
        // ruleid: jgates.java.ldap-injection
        template.authenticate("ou=people", "(uid=" + user + ")", req.getParameter("password"));
        // ruleid: jgates.java.ldap-injection
        new LdapName("uid=" + user + ",ou=people");
        // ok: jgates.java.ldap-injection
        ctx.search("ou=people,dc=example,dc=com", "(uid={0})", new Object[] {user}, controls);
        // ok: jgates.java.ldap-injection
        ctx.search("ou=people,dc=example,dc=com", "(objectClass=person)", controls);
        // ok: jgates.java.ldap-injection
        template.search("ou=people", "(uid=" + LdapEncoder.filterEncode(user) + ")", mapper);
        // ok: jgates.java.ldap-injection
        template.search("ou=people", "(uid=" + Encode.forLdap(user) + ")", mapper);
        // ok: jgates.java.ldap-injection
        new LdapName("uid=" + Rdn.escapeValue(user) + ",ou=people");
        // ok: jgates.java.ldap-injection
        new LdapName("uid=" + Encode.forLdapDn(user) + ",ou=people");
        // ok: jgates.java.ldap-injection
        new LdapName("uid=" + LdapEncoder.nameEncode(user) + ",ou=people");
        // ok: jgates.java.ldap-injection
        template.search(LdapQueryBuilder.query().where("uid").is(user), mapper);
    }

    void xpath(HttpServletRequest req, XPath xpath, Node doc, Object source) throws Exception {
        String name = req.getParameter("name");
        // ruleid: jgates.java.xpath-injection
        xpath.evaluate("//user[@name='" + name + "']", source);
        // ruleid: jgates.java.xpath-injection
        xpath.compile("//user[@name='" + name + "']/email");
        // ruleid: jgates.java.xpath-injection
        doc.selectNodes("//user[@name='" + name + "']");
        // ruleid: jgates.java.xpath-injection
        new DOMXPath("//user[@id=" + name + "]");
        // ok: jgates.java.xpath-injection
        xpath.setXPathVariableResolver(new MapResolver(name));
        xpath.evaluate("//user[@name=$name]", source);
        // ok: jgates.java.xpath-injection
        xpath.compile("//user[@active='true']");
        // ok: jgates.java.xpath-injection
        doc.selectNodes("//user[@name='" + ESAPI.encoder().encodeForXPath(name) + "']");
        // ok: jgates.java.xpath-injection
        doc.selectNodes("//user");
    }

    void templates(HttpServletRequest req, VelocityEngine velocity, Handlebars handlebars, Jinjava jinjava, Context context, Writer out) throws Exception {
        String text = req.getParameter("template");
        // ruleid: jgates.java.template-from-request
        Velocity.evaluate(context, out, "page", text);
        // ruleid: jgates.java.template-from-request
        velocity.evaluate(context, out, "page", "Hello " + text);
        // ruleid: jgates.java.template-from-request
        new Template("page", new StringReader(text), configuration);
        // ruleid: jgates.java.template-from-request
        handlebars.compileInline(text);
        // ruleid: jgates.java.template-from-request
        jinjava.render(text, bindings);
        // ok: jgates.java.template-from-request
        Velocity.evaluate(context, out, "page", "Hello $name");
        // ok: jgates.java.template-from-request
        velocity.getTemplate("greeting.vm").merge(context, out);
        // ok: jgates.java.template-from-request
        new Template("page", new StringReader("Hello ${name}"), configuration);
        // ok: jgates.java.template-from-request
        jinjava.render("Hello {{ name }}", bindings);
    }

    void code(HttpServletRequest req, ScriptEngine engine, ExpressionParser parser, GroovyShell shell, String script, String expr) throws Exception {
        // ruleid: jgates.java.dynamic-code-execution
        engine.eval(script);
        // ruleid: jgates.java.dynamic-code-execution
        engine.eval("var total = " + req.getParameter("total"));
        // ruleid: jgates.java.dynamic-code-execution
        parser.parseExpression(expr);
        // ruleid: jgates.java.dynamic-code-execution
        new SpelExpressionParser().parseExpression(req.getParameter("filter"));
        // ruleid: jgates.java.dynamic-code-execution
        Ognl.parseExpression(expr);
        // ruleid: jgates.java.dynamic-code-execution
        MVEL.eval(expr, vars);
        // ruleid: jgates.java.dynamic-code-execution
        shell.evaluate(script);
        // ok: jgates.java.dynamic-code-execution
        engine.eval("1 + 1");
        // ok: jgates.java.dynamic-code-execution
        engine.eval(SCRIPT);
        // ok: jgates.java.dynamic-code-execution
        parser.parseExpression("name").getValue(SimpleEvaluationContext.forReadOnlyDataBinding().build(), bean);
        // ok: jgates.java.dynamic-code-execution
        MVEL.eval("a + b", vars);
        // ok: jgates.java.dynamic-code-execution
        shell.evaluate("1 + 2");
    }

    void jndi(HttpServletRequest req, Context ctx, String name) throws Exception {
        // ruleid: jgates.java.jndi-lookup-from-request
        ctx.lookup(req.getParameter("ds"));
        // ruleid: jgates.java.jndi-lookup-from-request
        ctx.lookup(name);
        // ruleid: jgates.java.jndi-lookup-from-request
        new InitialContext().lookup("java:comp/env/" + name);
        // ok: jgates.java.jndi-lookup-from-request
        ctx.lookup("java:comp/env/jdbc/app");
        // ok: jgates.java.jndi-lookup-from-request
        new InitialContext().lookup("java:comp/env/jdbc/" + "app");
        // ok: jgates.java.jndi-lookup-from-request
        ctx.lookup(DATASOURCE_NAME);
    }

    void xslt(HttpServletRequest req, TransformerFactory factory, Source xml, Result result) throws Exception {
        String sheet = req.getParameter("stylesheet");
        // ruleid: jgates.java.xslt-from-request
        factory.newTransformer(new StreamSource(new StringReader(sheet)));
        // ruleid: jgates.java.xslt-from-request
        factory.newTemplates(new StreamSource(new StringReader(sheet)));
        // ok: jgates.java.xslt-from-request
        factory.newTransformer(new StreamSource(new File("report.xsl")));
        // ok: jgates.java.xslt-from-request
        factory.newTransformer(new StreamSource(new StringReader("<xsl:stylesheet version=\"1.0\"/>")));
        // ok: jgates.java.xslt-from-request
        Transformer transformer = factory.newTransformer(new StreamSource(new File("report.xsl")));
        transformer.setParameter("title", sheet);
        transformer.transform(new StreamSource(new StringReader(sheet)), result);
    }

    void latex(String file) throws Exception {
        // ruleid: jgates.java.latex-shell-escape
        new ProcessBuilder("pdflatex", "-shell-escape", file).start();
        // ruleid: jgates.java.latex-shell-escape
        new ProcessBuilder(List.of("lualatex", "--enable-write18", file)).start();
        // ruleid: jgates.java.latex-shell-escape
        Runtime.getRuntime().exec("pdflatex -shell-escape report.tex");
        // ruleid: jgates.java.latex-shell-escape
        Runtime.getRuntime().exec(new String[] {"xelatex", "-enable-write18", file});
        // ok: jgates.java.latex-shell-escape
        new ProcessBuilder("pdflatex", "-no-shell-escape", "-interaction=nonstopmode", file).start();
        // ok: jgates.java.latex-shell-escape
        new ProcessBuilder("pdflatex", "-interaction=nonstopmode", file).start();
        // ok: jgates.java.latex-shell-escape
        Runtime.getRuntime().exec("pdflatex -no-shell-escape report.tex");
    }
}
