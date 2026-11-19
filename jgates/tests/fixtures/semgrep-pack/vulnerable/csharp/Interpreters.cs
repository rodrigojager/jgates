using System.Diagnostics;
using System.DirectoryServices;
using System.Threading.Tasks;
using System.Xml;
using System.Xml.Xsl;
using Microsoft.AspNetCore.Mvc;
using Microsoft.CodeAnalysis.CSharp.Scripting;

public class DirectoryController : Controller
{
    public IActionResult FindUser(string uid)
    {
        var entry = new DirectoryEntry("LDAP://dc=example,dc=com");
        var searcher = new DirectorySearcher(entry, "(uid=" + uid + ")");
        return Ok(searcher.FindOne());
    }

    public IActionResult FindNode(string name, XmlDocument doc)
    {
        var node = doc.SelectSingleNode("//user[@name='" + name + "']");
        return Ok(node.InnerText);
    }

    public IActionResult Preview(string source)
    {
        var template = Template.Parse(source);
        return Ok(template.Render());
    }

    public async Task<IActionResult> Calculate(string formula)
    {
        var result = await CSharpScript.EvaluateAsync(formula);
        return Ok(result);
    }

    public IActionResult Report(string sheet)
    {
        var xslt = new XslCompiledTransform();
        xslt.Load(sheet);
        return Ok();
    }

    public IActionResult Typeset()
    {
        Process.Start("pdflatex", "-shell-escape report.tex");
        return Ok();
    }
}
