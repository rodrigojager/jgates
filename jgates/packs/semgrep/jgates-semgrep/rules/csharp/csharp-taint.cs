using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

public class TaintSamples : Controller
{
    private readonly HttpClient client = new HttpClient();

    private static string ValidateUrl(string url)
    {
        return url;
    }

    public async Task<IActionResult> Fetch(string url)
    {
        // ruleid: jgates.csharp.ssrf
        var a = await client.GetStringAsync(url);
        var target = Request.Query["callback"];
        // ruleid: jgates.csharp.ssrf
        var b = await client.PostAsync(target, null);
        // ruleid: jgates.csharp.ssrf
        var c = WebRequest.Create(Request.Form["feed"]);
        // ok: jgates.csharp.ssrf
        var d = await client.GetStringAsync("https://api.example.com/status");
        // ok: jgates.csharp.ssrf
        var e = await client.GetStringAsync(ValidateUrl(url));
        return Ok(a + b + c + d + e);
    }

    public IActionResult Download(string name)
    {
        // ruleid: jgates.csharp.path-traversal
        var text = System.IO.File.ReadAllText(name);
        // ruleid: jgates.csharp.path-traversal
        var full = Path.Combine("/srv/files", Request.Query["file"]);
        // ruleid: jgates.csharp.path-traversal
        var stream = new FileStream(name, FileMode.Open);
        // ok: jgates.csharp.path-traversal
        var safe = System.IO.File.ReadAllText(Path.GetFileName(name));
        // ok: jgates.csharp.path-traversal
        var fixedPath = System.IO.File.ReadAllText("/srv/files/readme.txt");
        return Ok(text + full + stream + safe + fixedPath);
    }
}
