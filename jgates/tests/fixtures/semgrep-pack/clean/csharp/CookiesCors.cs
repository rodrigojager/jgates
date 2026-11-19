using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

public class SessionController : Controller
{
    private static readonly CookieOptions Safe = new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict };
    private static readonly HashSet<string> Allowed = new HashSet<string> { "https://app.example.com" };

    public IActionResult SignIn(string token)
    {
        Response.Cookies.Append("__Host-sid", token, Safe);
        return Ok();
    }

    public IActionResult Theme()
    {
        Response.Cookies.Append("__Host-theme", "dark", Safe);
        return Ok();
    }

    public IActionResult Data()
    {
        return Json(new { ok = true });
    }

    public void Echo()
    {
        var origin = Request.Headers["Origin"].ToString();
        if (Allowed.Contains(origin))
        {
            Response.Headers["Access-Control-Allow-Origin"] = origin;
        }
    }
}

public static class Startup
{
    public static void Configure(CorsPolicyBuilder builder, MvcOptions options)
    {
        builder.WithOrigins("https://app.example.com").AllowCredentials();
        builder.SetIsOriginAllowed(origin => origin == "https://app.example.com");
        options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute());
    }

    public static string ReportUrl(string page)
    {
        return "https://api.example.com/v1/report?page=" + Uri.EscapeDataString(page);
    }
}
