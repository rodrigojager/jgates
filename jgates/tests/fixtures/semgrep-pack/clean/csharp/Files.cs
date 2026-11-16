using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Mime;
using System.Net;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

public class DocumentsController : Controller
{
    private const string StoreDir = "/srv/documents";

    public string ReadBody(HttpListenerContext context)
    {
        if (context.Request.ContentLength64 > 1_000_000)
        {
            throw new InvalidDataException("request too large");
        }
        return new StreamReader(context.Request.InputStream).ReadToEnd();
    }

    [HttpPost]
    [RequestSizeLimit(10_000_000)]
    public async Task<IActionResult> Upload(IFormFile file)
    {
        var header = new byte[5];
        using (var probe = file.OpenReadStream())
        {
            probe.Read(header, 0, header.Length);
        }
        if (header[0] != 0x25 || header[1] != 0x50)
        {
            return BadRequest();
        }
        var target = Path.Combine(StoreDir, Path.GetFileName(file.FileName));
        using var stream = new FileStream(target, FileMode.Create);
        await file.CopyToAsync(stream);
        return Ok();
    }

    [HttpPost]
    public IActionResult Import(string archivePath)
    {
        var info = new FileInfo(archivePath);
        if (info.Length > 50_000_000)
        {
            return BadRequest();
        }
        ZipFile.ExtractToDirectory(archivePath, StoreDir);
        return Ok();
    }

    [HttpGet]
    public IActionResult Download(string name)
    {
        var disposition = new ContentDispositionHeaderValue("attachment") { FileName = name };
        Response.Headers["Content-Disposition"] = disposition.ToString();
        return Ok();
    }
}
