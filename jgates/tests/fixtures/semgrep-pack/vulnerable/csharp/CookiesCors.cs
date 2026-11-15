using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;

public class SessionController : Controller
{
    public IActionResult SignIn(string token)
    {
        Response.Cookies.Append("sid", token);
        return Ok();
    }

    public IActionResult Theme()
    {
        Response.Cookies.Append("theme", "dark", new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict });
        return Ok();
    }

    public IActionResult Data(string callback)
    {
        var json = "{}";
        return Content(callback + "(" + json + ")", "application/javascript");
    }

    public void Echo()
    {
        var origin = Request.Headers["Origin"].ToString();
        Response.Headers["Access-Control-Allow-Origin"] = origin;
    }
}

public static class Startup
{
    public static void Configure(CorsPolicyBuilder builder, MvcOptions options)
    {
        builder.AllowAnyOrigin().AllowAnyHeader().AllowCredentials();
        builder.SetIsOriginAllowed(_ => true);
        options.Filters.Add(new IgnoreAntiforgeryTokenAttribute());
    }

    public static string ReportUrl()
    {
        return "https://api.example.com/v1/report?api_key=" + Settings.ApiKey;
    }
}
