using System.Data;
using System.Diagnostics;
using System.DirectoryServices;
using System.Xml;
using System.Xml.Linq;
using System.Xml.XPath;
using System.Xml.Xsl;
using Microsoft.AspNetCore.Mvc;
using Microsoft.CodeAnalysis.CSharp.Scripting;

public class InterpreterSamples : Controller
{
    public IActionResult Ldap(string user)
    {
        var entry = new DirectoryEntry("LDAP://dc=example,dc=com");
        // ruleid: jgates.csharp.ldap-injection
        var a = new DirectorySearcher(entry, "(uid=" + user + ")");
        // ruleid: jgates.csharp.ldap-injection
        var b = new DirectorySearcher(entry, $"(&(objectClass=person)(cn={Request.Query["cn"]}))");
        DirectorySearcher c = new DirectorySearcher(entry);
        // ruleid: jgates.csharp.ldap-injection
        c.Filter = "(mail=" + user + ")";
        // ruleid: jgates.csharp.ldap-injection
        var d = new DirectoryEntry("LDAP://cn=" + user + ",dc=example,dc=com");
        // ok: jgates.csharp.ldap-injection
        var e = new DirectorySearcher(entry, "(uid=" + Encoder.LdapFilterEncode(user) + ")");
        // ok: jgates.csharp.ldap-injection
        var f = new DirectorySearcher(entry, "(objectClass=person)");
        // ok: jgates.csharp.ldap-injection
        var g = new DirectoryEntry("LDAP://cn=" + Encoder.LdapDistinguishedNameEncode(user) + ",dc=example,dc=com");
        return Ok();
    }

    public IActionResult XPath(string name, XmlDocument doc, XElement root)
    {
        // ruleid: jgates.csharp.xpath-injection
        var a = doc.SelectNodes("//user[@name='" + name + "']");
        // ruleid: jgates.csharp.xpath-injection
        var b = doc.SelectSingleNode($"//user[@id='{Request.Query["id"]}']");
        // ruleid: jgates.csharp.xpath-injection
        var c = root.XPathSelectElements("/users/user[name='" + name + "']");
        // ruleid: jgates.csharp.xpath-injection
        var d = XPathExpression.Compile("//user[@name='" + name + "']");
        // ok: jgates.csharp.xpath-injection
        var e = doc.SelectNodes("//user[@active='true']");
        // ok: jgates.csharp.xpath-injection
        var f = XPathExpression.Compile("//user[@name=$name]");
        return Ok();
    }

    public IActionResult Render(string source)
    {
        // ruleid: jgates.csharp.template-from-request
        var a = Template.Parse(source);
        // ruleid: jgates.csharp.template-from-request
        var b = Handlebars.Compile("Hello " + Request.Form["greeting"]);
        // ruleid: jgates.csharp.template-from-request
        var c = new FluidParser().Parse(source);
        // ruleid: jgates.csharp.template-from-request
        var d = Engine.Razor.RunCompile(source, "key", null, null);
        // ok: jgates.csharp.template-from-request
        var e = Template.Parse("Hello {{ name }}");
        // ok: jgates.csharp.template-from-request
        var f = Handlebars.Compile("<p>{{title}}</p>").Invoke(new { title = source });
        return Ok();
    }

    public async System.Threading.Tasks.Task<IActionResult> Evaluate(string code, string expression)
    {
        // ruleid: jgates.csharp.dynamic-code-execution
        var a = await CSharpScript.EvaluateAsync(code);
        // ruleid: jgates.csharp.dynamic-code-execution
        var b = await CSharpScript.EvaluateAsync<int>("1 + " + expression);
        // ruleid: jgates.csharp.dynamic-code-execution
        var c = new DataTable().Compute(expression, "");
        // ruleid: jgates.csharp.dynamic-code-execution
        var d = CSharpScript.Create(Request.Form["script"]);
        // ok: jgates.csharp.dynamic-code-execution
        var e = await CSharpScript.EvaluateAsync("1 + 1");
        // ok: jgates.csharp.dynamic-code-execution
        var f = new DataTable().Compute("SUM(Price)", "Kind = 'book'");
        return Ok();
    }

    public IActionResult Transform(string sheet)
    {
        var xslt = new XslCompiledTransform();
        // ruleid: jgates.csharp.xslt-from-request
        xslt.Load(sheet);
        // ruleid: jgates.csharp.xslt-from-request
        xslt.Load(Request.Query["style"]);
        // ok: jgates.csharp.xslt-from-request
        xslt.Load("styles/report.xslt");
        // ok: jgates.csharp.xslt-from-request
        var args = new XsltArgumentList();
        args.AddParam("title", "", sheet);
        return Ok();
    }

    public void Typeset(string file)
    {
        // ruleid: jgates.csharp.latex-shell-escape
        Process.Start("pdflatex", "-shell-escape report.tex");
        // ruleid: jgates.csharp.latex-shell-escape
        var info = new ProcessStartInfo("xelatex", "--shell-escape " + file);
        var p = new ProcessStartInfo();
        p.FileName = "lualatex";
        // ruleid: jgates.csharp.latex-shell-escape
        p.Arguments = "-enable-write18 report.tex";
        // ok: jgates.csharp.latex-shell-escape
        Process.Start("pdflatex", "-no-shell-escape -interaction=nonstopmode report.tex");
        // ok: jgates.csharp.latex-shell-escape
        var safe = new ProcessStartInfo("pdflatex", "-shell-restricted report.tex");
    }
}
