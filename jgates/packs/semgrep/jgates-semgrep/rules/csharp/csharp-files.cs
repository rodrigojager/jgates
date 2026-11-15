using System;
using System.IO;
using System.IO.Compression;
using System.Formats.Tar;
using System.Net;
using System.Net.Mime;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

public class UploadFixtures : Controller
{
    private const string UploadDir = "/srv/uploads";

    // ---- upload-client-filename-in-path ----

    public async Task<IActionResult> SaveBad1(IFormFile file)
    {
        // ruleid: jgates.csharp.upload-client-filename-in-path
        var target = Path.Combine(UploadDir, file.FileName);
        // ruleid: jgates.csharp.upload-client-filename-in-path
        using var stream = new FileStream(target, FileMode.Create);
        await file.CopyToAsync(stream);
        return Ok();
    }

    public IActionResult SaveBad2(IFormFile upload)
    {
        // ruleid: jgates.csharp.upload-client-filename-in-path
        System.IO.File.WriteAllBytes("/srv/uploads/" + upload.FileName, new byte[0]);
        return Ok();
    }

    public IActionResult SaveBad3()
    {
        foreach (var f in Request.Form.Files)
        {
            // ruleid: jgates.csharp.upload-client-filename-in-path
            using var s = new FileStream(Path.Combine(UploadDir, f.FileName), FileMode.Create);
        }
        return Ok();
    }

    public IActionResult SaveOk1(IFormFile file)
    {
        // ok: jgates.csharp.upload-client-filename-in-path
        var target = Path.Combine(UploadDir, Path.GetFileName(file.FileName));
        using var stream = new FileStream(target, FileMode.Create);
        return Ok();
    }

    public IActionResult SaveOk2(IFormFile file)
    {
        // ok: jgates.csharp.upload-client-filename-in-path
        var target = Path.Combine(UploadDir, Path.GetRandomFileName());
        using var stream = new FileStream(target, FileMode.Create);
        return Ok();
    }

    public IActionResult SaveOk3(IFormFile file)
    {
        // ok: jgates.csharp.upload-client-filename-in-path
        var target = Path.Combine(UploadDir, Guid.NewGuid().ToString() + Path.GetExtension(file.FileName));
        using var stream = new FileStream(target, FileMode.Create);
        return Ok();
    }

    // ---- archive-extraction-unchecked ----

    public void ExtractBad1(string archivePath)
    {
        // ruleid: jgates.csharp.archive-extraction-unchecked
        ZipFile.ExtractToDirectory(archivePath, UploadDir);
    }

    public void ExtractBad2(ZipArchive archive)
    {
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            // ruleid: jgates.csharp.archive-extraction-unchecked
            entry.ExtractToFile(Path.Combine(UploadDir, entry.FullName), true);
        }
    }

    public void ExtractBad3(Stream input)
    {
        using var reader = new TarReader(input);
        TarEntry entry;
        while ((entry = reader.GetNextEntry()) != null)
        {
            // ruleid: jgates.csharp.archive-extraction-unchecked
            using var output = new FileStream(Path.Combine(UploadDir, entry.Name), FileMode.Create);
            entry.DataStream.CopyTo(output);
        }
    }

    public void ExtractOk1(string archivePath)
    {
        var info = new FileInfo(archivePath);
        if (info.Length > 50_000_000)
        {
            throw new InvalidDataException("archive too large");
        }
        // ok: jgates.csharp.archive-extraction-unchecked
        ZipFile.ExtractToDirectory(archivePath, UploadDir);
    }

    public void ExtractOk2(ZipArchive archive)
    {
        var root = Path.GetFullPath(UploadDir) + Path.DirectorySeparatorChar;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            var dest = Path.GetFullPath(Path.Combine(UploadDir, entry.FullName));
            if (!dest.StartsWith(root, StringComparison.Ordinal))
            {
                throw new InvalidDataException("entry outside the target folder");
            }
            // ok: jgates.csharp.archive-extraction-unchecked
            entry.ExtractToFile(Path.Combine(UploadDir, entry.FullName), true);
        }
    }

    public void ExtractOk3(Stream input)
    {
        using var reader = new TarReader(input);
        TarEntry entry;
        while ((entry = reader.GetNextEntry()) != null)
        {
            if (Path.IsPathRooted(entry.Name) || entry.Name.Contains(".."))
            {
                continue;
            }
            // ok: jgates.csharp.archive-extraction-unchecked
            using var output = new FileStream(Path.Combine(UploadDir, entry.Name), FileMode.Create);
            entry.DataStream.CopyTo(output);
        }
    }

    // ---- request-body-without-size-limit ----

    public void LimitBad1(WebApplicationBuilder builder)
    {
        builder.WebHost.ConfigureKestrel(o =>
        {
            // ruleid: jgates.csharp.request-body-without-size-limit
            o.Limits.MaxRequestBodySize = null;
        });
    }

    // ruleid: jgates.csharp.request-body-without-size-limit
    [DisableRequestSizeLimit]
    public IActionResult LimitBad2() => Ok();

    public void LimitBad3(FormOptions options)
    {
        // ruleid: jgates.csharp.request-body-without-size-limit
        options.MultipartBodyLengthLimit = long.MaxValue;
    }

    public void LimitBad4(HttpListenerContext ctx)
    {
        // ruleid: jgates.csharp.request-body-without-size-limit
        var body = new StreamReader(ctx.Request.InputStream).ReadToEnd();
    }

    public void LimitOk1(WebApplicationBuilder builder)
    {
        builder.WebHost.ConfigureKestrel(o =>
        {
            // ok: jgates.csharp.request-body-without-size-limit
            o.Limits.MaxRequestBodySize = 10_000_000;
        });
    }

    // ok: jgates.csharp.request-body-without-size-limit
    [RequestSizeLimit(10_000_000)]
    public IActionResult LimitOk2() => Ok();

    public void LimitOk3(HttpListenerContext ctx)
    {
        if (ctx.Request.ContentLength64 > 1_000_000)
        {
            return;
        }
        // ok: jgates.csharp.request-body-without-size-limit
        var body = new StreamReader(ctx.Request.InputStream).ReadToEnd();
    }

    // ---- upload-content-type-trusted ----

    public IActionResult TypeBad1(IFormFile file)
    {
        // ruleid: jgates.csharp.upload-content-type-trusted
        if (file.ContentType != "image/png")
        {
            return BadRequest();
        }
        return Ok();
    }

    public IActionResult TypeBad2(IFormFile file)
    {
        var allowed = new[] { "image/png", "image/jpeg" };
        // ruleid: jgates.csharp.upload-content-type-trusted
        if (!allowed.Contains(file.ContentType))
        {
            return BadRequest();
        }
        return Ok();
    }

    public IActionResult TypeOk1(IFormFile file)
    {
        var header = new byte[4];
        using var s = file.OpenReadStream();
        s.Read(header, 0, 4);
        // ok: jgates.csharp.upload-content-type-trusted
        if (header[0] != 0x89 || header[1] != 0x50)
        {
            return BadRequest();
        }
        return Ok();
    }

    public IActionResult TypeOk2(IFormFile file, string expected)
    {
        // ok: jgates.csharp.upload-content-type-trusted
        if (file.Length == 0 || expected == "png")
        {
            return BadRequest();
        }
        return Ok();
    }

    // ---- content-disposition-from-request ----

    public void HeaderBad1(string name)
    {
        // ruleid: jgates.csharp.content-disposition-from-request
        Response.Headers["Content-Disposition"] = "attachment; filename=\"" + name + "\"";
    }

    public void HeaderBad2()
    {
        var wanted = Request.Query["file"];
        // ruleid: jgates.csharp.content-disposition-from-request
        Response.Headers.Append("Content-Disposition", $"attachment; filename={wanted}");
    }

    public void HeaderOk1(string name)
    {
        var cd = new ContentDispositionHeaderValue("attachment") { FileName = name };
        // ok: jgates.csharp.content-disposition-from-request
        Response.Headers["Content-Disposition"] = cd.ToString();
    }

    public void HeaderOk2(string name)
    {
        var cd = new ContentDisposition { FileName = name };
        // ok: jgates.csharp.content-disposition-from-request
        Response.Headers.Append("Content-Disposition", cd.ToString());
    }
}
