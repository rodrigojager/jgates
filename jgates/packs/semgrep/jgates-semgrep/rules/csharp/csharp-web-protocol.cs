using System;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

public class WebProtocolSamples : Controller
{
    // security-headers-disabled
    public void Headers(IServiceCollection services)
    {
        // ruleid: jgates.csharp.security-headers-disabled
        services.AddHsts(o => { o.MaxAge = TimeSpan.FromDays(30); });
        // ruleid: jgates.csharp.security-headers-disabled
        services.AddHsts(o => { o.MaxAge = TimeSpan.Zero; });
        // ruleid: jgates.csharp.security-headers-disabled
        services.AddAntiforgery(o => { o.SuppressXFrameOptionsHeader = true; });
        // ruleid: jgates.csharp.security-headers-disabled
        Response.Headers.Remove("X-Content-Type-Options");
        // ok: jgates.csharp.security-headers-disabled
        services.AddHsts(o => { o.MaxAge = TimeSpan.FromDays(365); o.IncludeSubDomains = true; });
        // ok: jgates.csharp.security-headers-disabled
        services.AddAntiforgery(o => { o.SuppressXFrameOptionsHeader = false; });
        // ok: jgates.csharp.security-headers-disabled
        Response.Headers.Remove("Server");
    }

    // csp-unsafe-directive
    public void Csp()
    {
        // ruleid: jgates.csharp.csp-unsafe-directive
        Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'";
        // ruleid: jgates.csharp.csp-unsafe-directive
        Response.Headers.Append("Content-Security-Policy", "script-src * ; object-src 'none'");
        // ruleid: jgates.csharp.csp-unsafe-directive
        Response.Headers.ContentSecurityPolicy = "default-src 'self' 'unsafe-eval'";
        // ok: jgates.csharp.csp-unsafe-directive
        Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'nonce-abc123'; object-src 'none'";
        // ok: jgates.csharp.csp-unsafe-directive
        Response.Headers.Append("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'");
        // ok: jgates.csharp.csp-unsafe-directive
        Response.Headers["X-Frame-Options"] = "script-src 'unsafe-inline'";
    }

    // websocket-without-tls
    public async Task Sockets(ClientWebSocket ws, CancellationToken ct)
    {
        // ruleid: jgates.csharp.websocket-without-tls
        await ws.ConnectAsync(new Uri("ws://feed.example.com/stream"), ct);
        // ruleid: jgates.csharp.websocket-without-tls
        await ws.ConnectAsync(new Uri("ws://203.0.113.9:8080/live"), CancellationToken.None);
        // ok: jgates.csharp.websocket-without-tls
        await ws.ConnectAsync(new Uri("wss://feed.example.com/stream"), ct);
        // ok: jgates.csharp.websocket-without-tls
        await ws.ConnectAsync(new Uri("ws://localhost:5000/dev"), ct);
    }

    // websocket-origin-not-checked
    public void Origins(IApplicationBuilder app)
    {
        var options = new WebSocketOptions();
        // ruleid: jgates.csharp.websocket-origin-not-checked
        options.AllowedOrigins.Add("*");
        // ruleid: jgates.csharp.websocket-origin-not-checked
        app.UseWebSockets(new WebSocketOptions { AllowedOrigins = { "*" } });
        // ok: jgates.csharp.websocket-origin-not-checked
        options.AllowedOrigins.Add("https://app.example.com");
        // ok: jgates.csharp.websocket-origin-not-checked
        app.UseWebSockets(new WebSocketOptions { AllowedOrigins = { "https://app.example.com" } });
    }

    // graphql-introspection-enabled
    public void Introspection(IServiceCollection services)
    {
        // ruleid: jgates.csharp.graphql-introspection-enabled
        services.AddGraphQLServer().AddMaxExecutionDepthRule(8).AllowIntrospection(true);
        // ruleid: jgates.csharp.graphql-introspection-enabled
        services.AddGraphQLServer().AddQueryType<Query>().AddMaxExecutionDepthRule(8).AllowIntrospection(true);
        // ok: jgates.csharp.graphql-introspection-enabled
        services.AddGraphQLServer().AddMaxExecutionDepthRule(8).AllowIntrospection(false);
        // ok: jgates.csharp.graphql-introspection-enabled
        services.AddGraphQLServer().AddMaxExecutionDepthRule(8).AllowIntrospection(env.IsDevelopment());
    }

    // graphql-without-depth-limit
    public void Depth(IServiceCollection services)
    {
        // ruleid: jgates.csharp.graphql-without-depth-limit
        services.AddGraphQLServer().AddQueryType<Query>();
        // ruleid: jgates.csharp.graphql-without-depth-limit
        builder.Services.AddGraphQLServer().AddQueryType<Query>().AddFiltering();
        // ok: jgates.csharp.graphql-without-depth-limit
        services.AddGraphQLServer().AddQueryType<Query>().AddMaxExecutionDepthRule(8);
        // ok: jgates.csharp.graphql-without-depth-limit
        builder.Services.AddGraphQLServer().AddQueryType<Query>().ModifyCostOptions(o => { o.MaxFieldCost = 1000; });
    }

    // open-redirect
    public IActionResult Go(string next, string safe)
    {
        // ruleid: jgates.csharp.open-redirect
        return Redirect(next);
    }

    public IActionResult GoQuery()
    {
        // ruleid: jgates.csharp.open-redirect
        return Redirect(Request.Query["returnUrl"]);
    }

    public IActionResult GoResponse(string target)
    {
        // ruleid: jgates.csharp.open-redirect
        Response.Redirect(target);
        return Ok();
    }

    public IActionResult GoLocal(string next)
    {
        // ok: jgates.csharp.open-redirect
        return LocalRedirect(next);
    }

    public IActionResult GoChecked(string next)
    {
        if (Url.IsLocalUrl(next))
        {
            // ok: jgates.csharp.open-redirect
            return Redirect(next);
        }
        // ok: jgates.csharp.open-redirect
        return Redirect("/home");
    }

    // client-ip-from-forwarded-header
    public string ClientIp()
    {
        // ruleid: jgates.csharp.client-ip-from-forwarded-header
        var a = Request.Headers["X-Forwarded-For"];
        // ruleid: jgates.csharp.client-ip-from-forwarded-header
        var b = Request.Headers["X-Real-IP"].ToString();
        // ok: jgates.csharp.client-ip-from-forwarded-header
        var c = HttpContext.Connection.RemoteIpAddress.ToString();
        // ok: jgates.csharp.client-ip-from-forwarded-header
        var d = Request.Headers["User-Agent"];
        return a + b + c + d;
    }

    // host-header-in-url
    public string Links()
    {
        var host = Request.Host.Value;
        // ruleid: jgates.csharp.host-header-in-url
        var a = "https://" + host + "/reset";
        // ruleid: jgates.csharp.host-header-in-url
        var b = $"https://{Request.Host}/verify";
        // ruleid: jgates.csharp.host-header-in-url
        var c = new UriBuilder("https", Request.Host.Host).ToString();
        // ok: jgates.csharp.host-header-in-url
        var d = "https://" + configuredHost + "/reset";
        // ok: jgates.csharp.host-header-in-url
        var e = $"{baseUrl}/verify";
        return a + b + c + d + e;
    }
}
