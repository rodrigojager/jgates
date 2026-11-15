using System;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

public class DocumentsController : Controller
{
    private const string StoreDir = "/srv/documents";

    [HttpPost]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> Upload(IFormFile file)
    {
        if (file.ContentType != "application/pdf")
        {
            return BadRequest();
        }
        var target = Path.Combine(StoreDir, file.FileName);
        using var stream = new FileStream(target, FileMode.Create);
        await file.CopyToAsync(stream);
        return Ok();
    }

    [HttpPost]
    public IActionResult Import(string archivePath)
    {
        ZipFile.ExtractToDirectory(archivePath, StoreDir);
        return Ok();
    }

    [HttpGet]
    public IActionResult Download(string name)
    {
        Response.Headers["Content-Disposition"] = "attachment; filename=\"" + name + "\"";
        return Ok();
    }
}
