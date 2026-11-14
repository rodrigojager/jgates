using System.Net;
using System.Text.Encodings.Web;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Html;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Rendering;

public class XssSamples : Controller
{
    public async Task Greet(string name)
    {
        // ruleid: jgates.csharp.reflected-xss
        await Response.WriteAsync(name);
        // ruleid: jgates.csharp.reflected-xss
        await Response.WriteAsync(Request.Query["q"]);
        // ruleid: jgates.csharp.reflected-xss
        Response.Write(Request.Form["comment"]);
        // ok: jgates.csharp.reflected-xss
        await Response.WriteAsync("<p>Welcome</p>");
        // ok: jgates.csharp.reflected-xss
        await Response.WriteAsync(HtmlEncoder.Default.Encode(name));
        // ok: jgates.csharp.reflected-xss
        await Response.WriteAsync(WebUtility.HtmlEncode(Request.Query["q"]));
    }

    private void Build(IHtmlHelper Html, string title, string body)
    {
        // ruleid: jgates.csharp.raw-html-non-literal
        var a = Html.Raw("<h1>" + title + "</h1>");
        // ruleid: jgates.csharp.raw-html-non-literal
        var b = Html.Raw($"<div>{body}</div>");
        // ruleid: jgates.csharp.raw-html-non-literal
        var c = new HtmlString("<b>" + title + "</b>");
        // ruleid: jgates.csharp.raw-html-non-literal
        var d = new HtmlString($"<i>{body}</i>");
        // ok: jgates.csharp.raw-html-non-literal
        var e = Html.Raw("<hr />");
        // ok: jgates.csharp.raw-html-non-literal
        var f = new HtmlString("<br />");
        // ok: jgates.csharp.raw-html-non-literal
        var g = Html.Raw(HtmlEncoder.Default.Encode(title));
    }
}
