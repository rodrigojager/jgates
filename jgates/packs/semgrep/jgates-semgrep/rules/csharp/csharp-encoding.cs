using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Web;
using CommonMark;
using CsvHelper;
using Enyim.Caching;
using Markdig;
using Microsoft.AspNetCore.Mvc;

public class EncodingSamples : Controller
{
    private readonly IMemcachedClient cache;
    private readonly MarkdownPipeline noHtml = new MarkdownPipelineBuilder().DisableHtml().Build();

    private static string SanitizeCsvField(string v)
    {
        return "'" + v;
    }

    private static string ValidateCacheKey(string v)
    {
        return v;
    }

    // regex-from-request

    public IActionResult Search(string term)
    {
        // ruleid: jgates.csharp.regex-from-request
        var re = new Regex(term);
        // ruleid: jgates.csharp.regex-from-request
        var hit = Regex.IsMatch("some text", "^" + Request.Query["prefix"]);
        // ruleid: jgates.csharp.regex-from-request
        var parts = Regex.Split("a,b", term);
        // ok: jgates.csharp.regex-from-request
        var safe = new Regex("^" + Regex.Escape(term));
        // ok: jgates.csharp.regex-from-request
        var safeStatic = Regex.IsMatch("some text", Regex.Escape(term));
        // ok: jgates.csharp.regex-from-request
        var fixedPattern = new Regex("^[a-z]+$");
        return Ok(re.ToString() + hit + parts + safe + safeStatic + fixedPattern);
    }

    // redos-nested-quantifier

    public void Patterns(string input)
    {
        // ruleid: jgates.csharp.redos-nested-quantifier
        var a = new Regex("^(a+)+$");
        // ruleid: jgates.csharp.redos-nested-quantifier
        var b = Regex.IsMatch(input, @"^(\w*)*$");
        // ruleid: jgates.csharp.redos-nested-quantifier
        var c = Regex.Match(input, "^([a-z]+)*end");
        // ok: jgates.csharp.redos-nested-quantifier
        var d = new Regex("^(ab)+$");
        // ok: jgates.csharp.redos-nested-quantifier
        var e = Regex.IsMatch(input, @"^[a-z]+$", RegexOptions.None, TimeSpan.FromSeconds(1));
        // ok: jgates.csharp.redos-nested-quantifier
        var f = new Regex(@"^(a\+)+$");
        // ok: jgates.csharp.redos-nested-quantifier
        var g = new Regex("^(a+)?$");
    }

    // format-string-from-request

    public IActionResult Greet(string template)
    {
        // ruleid: jgates.csharp.format-string-from-request
        var a = string.Format(template, "x");
        // ruleid: jgates.csharp.format-string-from-request
        Console.WriteLine(Request.Query["fmt"], "x");
        // ruleid: jgates.csharp.format-string-from-request
        var b = string.Format(CultureInfo.InvariantCulture, template, 1);
        // ok: jgates.csharp.format-string-from-request
        var c = string.Format("{0}", template);
        // ok: jgates.csharp.format-string-from-request
        Console.WriteLine("{0}", Request.Query["fmt"]);
        // ok: jgates.csharp.format-string-from-request
        var d = string.Format("Hello {0}", template);
        return Ok(a + b + c + d);
    }

    // csv-formula-injection

    public void Export(CsvWriter csv, string name)
    {
        // ruleid: jgates.csharp.csv-formula-injection
        csv.WriteField(name);
        // ruleid: jgates.csharp.csv-formula-injection
        csv.WriteField(Request.Form["comment"]);
        // ok: jgates.csharp.csv-formula-injection
        csv.WriteField(SanitizeCsvField(name));
        // ok: jgates.csharp.csv-formula-injection
        csv.WriteField("Total");
        csv.NextRecord();
    }

    // memcache-key-from-request

    public object Lookup(string key)
    {
        // ruleid: jgates.csharp.memcache-key-from-request
        var a = cache.Get(key);
        // ruleid: jgates.csharp.memcache-key-from-request
        cache.Remove("user:" + Request.Query["id"]);
        // ruleid: jgates.csharp.memcache-key-from-request
        cache.Store(StoreMode.Set, key, "value");
        // ok: jgates.csharp.memcache-key-from-request
        var b = cache.Get(Convert.ToHexString(Encoding.UTF8.GetBytes(key)));
        // ok: jgates.csharp.memcache-key-from-request
        var c = cache.Get(ValidateCacheKey(key));
        // ok: jgates.csharp.memcache-key-from-request
        var d = cache.Get("settings");
        return a;
    }

    // double-decoding

    public string Decode(string raw, string other)
    {
        // ruleid: jgates.csharp.double-decoding
        var a = HttpUtility.UrlDecode(HttpUtility.UrlDecode(raw));
        // ruleid: jgates.csharp.double-decoding
        var b = WebUtility.HtmlDecode(WebUtility.HtmlDecode(raw));
        // ruleid: jgates.csharp.double-decoding
        string first = Uri.UnescapeDataString(raw);
        string second = Uri.UnescapeDataString(first);
        // ok: jgates.csharp.double-decoding
        var c = HttpUtility.UrlDecode(raw);
        // ok: jgates.csharp.double-decoding
        var d = WebUtility.HtmlDecode(WebUtility.UrlDecode(raw));
        // ok: jgates.csharp.double-decoding
        string one = Uri.UnescapeDataString(raw);
        string two = Uri.UnescapeDataString(other);
        return a + b + second + c + d + one + two;
    }

    // url-parameter-unencoded

    public string Link(string city)
    {
        // ruleid: jgates.csharp.url-parameter-unencoded
        var a = "https://api.example.com/weather?city=" + city;
        // ruleid: jgates.csharp.url-parameter-unencoded
        var b = "https://api.example.com/users/" + Request.Query["id"];
        // ruleid: jgates.csharp.url-parameter-unencoded
        var c = string.Format("https://api.example.com/weather?city={0}", city);
        // ok: jgates.csharp.url-parameter-unencoded
        var d = "https://api.example.com/weather?city=" + Uri.EscapeDataString(city);
        // ok: jgates.csharp.url-parameter-unencoded
        var e = "https://api.example.com/users/" + WebUtility.UrlEncode(Request.Query["id"]);
        // ok: jgates.csharp.url-parameter-unencoded
        var f = "https://api.example.com/weather?city=berlin";
        return a + b + c + d + e + f;
    }

    // json-built-by-concatenation

    public IActionResult Payload(string user)
    {
        // ruleid: jgates.csharp.json-built-by-concatenation
        var a = "{\"user\":\"" + user + "\"}";
        // ruleid: jgates.csharp.json-built-by-concatenation
        var b = "{\"query\":\"" + Request.Query["q"] + "\"}";
        // ruleid: jgates.csharp.json-built-by-concatenation
        var c = string.Format("{{\"user\":\"{0}\"}}", user);
        // ok: jgates.csharp.json-built-by-concatenation
        var d = JsonSerializer.Serialize(new { user = user });
        // ok: jgates.csharp.json-built-by-concatenation
        var e = "{\"user\":\"" + JsonSerializer.Serialize(user) + "\"}";
        // ok: jgates.csharp.json-built-by-concatenation
        var f = "{\"status\":\"ok\"}";
        return Content(a + b + c + d + e + f);
    }

    // markdown-raw-html-enabled

    public string Render(string text)
    {
        // ruleid: jgates.csharp.markdown-raw-html-enabled
        var a = Markdown.ToHtml(text);
        // ruleid: jgates.csharp.markdown-raw-html-enabled
        var b = CommonMarkConverter.Convert(text);
        // ok: jgates.csharp.markdown-raw-html-enabled
        var c = Markdown.ToHtml(text, noHtml);
        // ok: jgates.csharp.markdown-raw-html-enabled
        var d = sanitizer.Sanitize(Markdown.ToHtml(text));
        // ok: jgates.csharp.markdown-raw-html-enabled
        var e = Markdown.ToHtml("# Static heading");
        return a + b + c + d + e;
    }
}
