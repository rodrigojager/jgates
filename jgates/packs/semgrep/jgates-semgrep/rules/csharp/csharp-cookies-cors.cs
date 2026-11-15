using System.Collections.Generic;
using System.Web;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;

public class CookieSamples : Controller
{
    private static readonly CookieOptions Safe = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict };

    public void SecureOption()
    {
        // ruleid: jgates.csharp.cookie-without-secure
        var a = new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict };
        // ruleid: jgates.csharp.cookie-without-secure
        var b = new CookieOptions { Secure = false, HttpOnly = true, SameSite = SameSiteMode.Strict };
        // ok: jgates.csharp.cookie-without-secure
        var c = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict };
    }

    public void SecureSetLater()
    {
        // ok: jgates.csharp.cookie-without-secure
        var o = new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict };
        o.Secure = true;
    }

    public void SecureAssignments(CookieAuthenticationOptions options, HttpCookie legacy)
    {
        // ruleid: jgates.csharp.cookie-without-secure
        options.Cookie.SecurePolicy = CookieSecurePolicy.None;
        // ruleid: jgates.csharp.cookie-without-secure
        legacy.Secure = false;
        // ruleid: jgates.csharp.cookie-without-secure
        var policy = new CookiePolicyOptions { Secure = CookieSecurePolicy.None };
        // ok: jgates.csharp.cookie-without-secure
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        // ok: jgates.csharp.cookie-without-secure
        legacy.Secure = true;
    }

    public void HttpOnlyOption()
    {
        // ruleid: jgates.csharp.cookie-without-httponly
        var a = new CookieOptions { Secure = true, SameSite = SameSiteMode.Strict };
        // ruleid: jgates.csharp.cookie-without-httponly
        var b = new CookieOptions { Secure = true, HttpOnly = false, SameSite = SameSiteMode.Strict };
        // ok: jgates.csharp.cookie-without-httponly
        var c = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict };
    }

    public void HttpOnlySetLater()
    {
        // ok: jgates.csharp.cookie-without-httponly
        var o = new CookieOptions { Secure = true, SameSite = SameSiteMode.Strict };
        o.HttpOnly = true;
    }

    public void HttpOnlyAssignments(CookieAuthenticationOptions options, HttpCookie legacy)
    {
        // ruleid: jgates.csharp.cookie-without-httponly
        options.Cookie.HttpOnly = false;
        // ruleid: jgates.csharp.cookie-without-httponly
        legacy.HttpOnly = false;
        // ruleid: jgates.csharp.cookie-without-httponly
        var policy = new CookiePolicyOptions { HttpOnly = HttpOnlyPolicy.None };
        // ok: jgates.csharp.cookie-without-httponly
        options.Cookie.HttpOnly = true;
        // ok: jgates.csharp.cookie-without-httponly
        var strict = new CookiePolicyOptions { HttpOnly = HttpOnlyPolicy.Always };
    }

    public void SameSiteOption()
    {
        // ruleid: jgates.csharp.cookie-without-samesite
        var a = new CookieOptions { Secure = true, HttpOnly = true };
        // ruleid: jgates.csharp.cookie-without-samesite
        var b = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.None };
        // ruleid: jgates.csharp.cookie-without-samesite
        var c = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Unspecified };
        // ok: jgates.csharp.cookie-without-samesite
        var d = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Lax };
    }

    public void SameSiteSetLater()
    {
        // ok: jgates.csharp.cookie-without-samesite
        var o = new CookieOptions { Secure = true, HttpOnly = true };
        o.SameSite = SameSiteMode.Strict;
    }

    public void SameSiteAssignments(CookieAuthenticationOptions options)
    {
        // ruleid: jgates.csharp.cookie-without-samesite
        options.Cookie.SameSite = SameSiteMode.None;
        // ruleid: jgates.csharp.cookie-without-samesite
        var policy = new CookiePolicyOptions { MinimumSameSitePolicy = SameSiteMode.None };
        // ok: jgates.csharp.cookie-without-samesite
        options.Cookie.SameSite = SameSiteMode.Strict;
        // ok: jgates.csharp.cookie-without-samesite
        var lax = new CookiePolicyOptions { MinimumSameSitePolicy = SameSiteMode.Lax };
    }

    public void AppendWithoutOptions(string token)
    {
        // ruleid: jgates.csharp.cookie-without-secure, jgates.csharp.cookie-without-httponly, jgates.csharp.cookie-without-samesite, jgates.csharp.cookie-name-without-prefix
        Response.Cookies.Append("sid", token);
        // ruleid: jgates.csharp.cookie-without-secure, jgates.csharp.cookie-without-httponly, jgates.csharp.cookie-without-samesite, jgates.csharp.cookie-name-without-prefix
        HttpContext.Response.Cookies.Append("theme", "dark");
        // ok: jgates.csharp.cookie-without-secure, jgates.csharp.cookie-without-httponly, jgates.csharp.cookie-without-samesite, jgates.csharp.cookie-name-without-prefix
        Response.Cookies.Append("__Host-sid", token, Safe);
    }

    public void CookieNames(CookieAuthenticationOptions options, string token)
    {
        // ruleid: jgates.csharp.cookie-name-without-prefix
        var legacy = new HttpCookie("sid");
        // ruleid: jgates.csharp.cookie-name-without-prefix
        options.Cookie.Name = "session";
        // ruleid: jgates.csharp.cookie-name-without-prefix
        Response.Cookies.Append("sid", token, Safe);
        // ok: jgates.csharp.cookie-name-without-prefix
        var host = new HttpCookie("__Host-sid");
        // ok: jgates.csharp.cookie-name-without-prefix
        options.Cookie.Name = "__Secure-session";
        // ok: jgates.csharp.cookie-name-without-prefix
        Response.Cookies.Append("__Host-sid", token, Safe);
    }
}

public class CorsSamples : Controller
{
    private static readonly HashSet<string> Allowed = new HashSet<string> { "https://app.example.com" };

    public void AnyOriginPolicies(CorsPolicyBuilder builder)
    {
        // ruleid: jgates.csharp.cors-any-origin-with-credentials
        builder.AllowAnyOrigin().AllowAnyHeader().AllowCredentials();
        // ruleid: jgates.csharp.cors-any-origin-with-credentials
        builder.AllowCredentials().AllowAnyOrigin();
        // ruleid: jgates.csharp.cors-any-origin-with-credentials
        builder.WithOrigins("*").AllowCredentials();
        // ok: jgates.csharp.cors-any-origin-with-credentials
        builder.WithOrigins("https://app.example.com").AllowCredentials();
        // ok: jgates.csharp.cors-any-origin-with-credentials
        builder.AllowAnyOrigin().AllowAnyMethod();
    }

    public void AnyOriginHeaders()
    {
        // ruleid: jgates.csharp.cors-any-origin-with-credentials
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Credentials"] = "true";
    }

    public void ListedOriginHeaders()
    {
        // ok: jgates.csharp.cors-any-origin-with-credentials
        Response.Headers["Access-Control-Allow-Origin"] = "https://app.example.com";
        Response.Headers["Access-Control-Allow-Credentials"] = "true";
    }

    public void ReflectedOrigin()
    {
        var origin = Request.Headers["Origin"].ToString();
        // ruleid: jgates.csharp.cors-origin-reflected
        Response.Headers["Access-Control-Allow-Origin"] = origin;
    }

    public void ReflectedOriginAppend()
    {
        // ruleid: jgates.csharp.cors-origin-reflected
        Response.Headers.Append("Access-Control-Allow-Origin", Request.Headers[HeaderNames.Origin]);
    }

    public void CheckedOrigin()
    {
        var origin = Request.Headers["Origin"].ToString();
        if (Allowed.Contains(origin))
        {
            // ok: jgates.csharp.cors-origin-reflected
            Response.Headers["Access-Control-Allow-Origin"] = origin;
        }
    }

    public void FixedOrigin()
    {
        // ok: jgates.csharp.cors-origin-reflected
        Response.Headers["Access-Control-Allow-Origin"] = "https://app.example.com";
    }

    public void OriginChecks(CorsPolicyBuilder builder)
    {
        // ruleid: jgates.csharp.cors-origin-reflected-allow-all
        builder.SetIsOriginAllowed(_ => true);
        // ruleid: jgates.csharp.cors-origin-reflected-allow-all
        builder.SetIsOriginAllowed((origin) => true);
        // ok: jgates.csharp.cors-origin-reflected-allow-all
        builder.SetIsOriginAllowed(origin => origin == "https://app.example.com");
        // ok: jgates.csharp.cors-origin-reflected-allow-all
        builder.SetIsOriginAllowed(origin => Allowed.Contains(origin));
    }
}

public class ForgerySamples
{
    public void Filters(MvcOptions options, RazorPagesOptions pages, WebApplication app)
    {
        // ruleid: jgates.csharp.csrf-protection-disabled
        options.Filters.Add(new IgnoreAntiforgeryTokenAttribute());
        // ruleid: jgates.csharp.csrf-protection-disabled
        pages.Conventions.ConfigureFilter(new IgnoreAntiforgeryTokenAttribute());
        // ruleid: jgates.csharp.csrf-protection-disabled
        app.MapGroup("/api").DisableAntiforgery();
        // ok: jgates.csharp.csrf-protection-disabled
        options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute());
        // ok: jgates.csharp.csrf-protection-disabled
        app.MapGroup("/api").RequireAuthorization();
    }
}

public class JsonpSamples : Controller
{
    public IActionResult ByParameter(string callback)
    {
        var json = "{}";
        // ruleid: jgates.csharp.jsonp-enabled
        return Content(callback + "(" + json + ")", "application/javascript");
    }

    public async Task ByQuery()
    {
        var cb = Request.Query["callback"];
        var json = "{}";
        // ruleid: jgates.csharp.jsonp-enabled
        await Response.WriteAsync($"{cb}({json})");
    }

    public IActionResult Plain(string callback)
    {
        var json = "{}";
        // ok: jgates.csharp.jsonp-enabled
        return Content(json, "application/json");
    }

    public IActionResult Typed()
    {
        // ok: jgates.csharp.jsonp-enabled
        return Json(new { ok = true });
    }
}

public class UrlSamples
{
    public void Urls(string key, string user, string pass, string page)
    {
        // ruleid: jgates.csharp.sensitive-query-parameter
        var a = "https://api.example.com/v1/items?api_key=" + key;
        // ruleid: jgates.csharp.sensitive-query-parameter
        var b = $"https://example.com/login?user={user}&password={pass}";
        // ruleid: jgates.csharp.sensitive-query-parameter
        var c = QueryHelpers.AddQueryString(a, "secret", key);
        // ruleid: jgates.csharp.sensitive-query-parameter
        var d = new UriBuilder("https://example.com/x") { Query = "apikey=" + key };
        // ok: jgates.csharp.sensitive-query-parameter
        var e = "https://api.example.com/v1/items?page=2";
        // ok: jgates.csharp.sensitive-query-parameter
        var f = QueryHelpers.AddQueryString(a, "page", page);
        // ok: jgates.csharp.sensitive-query-parameter
        var g = "https://example.com/items?passwordless=true";
    }
}
