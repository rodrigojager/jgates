using System;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

public class EdgeController : Controller
{
    private readonly string baseUrl = "https://app.example.com";

    public void Setup(IServiceCollection services, IApplicationBuilder app)
    {
        services.AddHsts(o => { o.MaxAge = TimeSpan.FromDays(365); });
        Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'nonce-abc123'; object-src 'none'";
        app.UseWebSockets(new WebSocketOptions { AllowedOrigins = { "https://app.example.com" } });
        services.AddGraphQLServer().AddQueryType<Query>().AllowIntrospection(false).AddMaxExecutionDepthRule(8);
    }

    public async Task Stream(ClientWebSocket ws, CancellationToken ct)
    {
        await ws.ConnectAsync(new Uri("wss://feed.example.com/stream"), ct);
    }

    public IActionResult Go(string next)
    {
        return LocalRedirect(next);
    }

    public string Caller()
    {
        return HttpContext.Connection.RemoteIpAddress.ToString();
    }

    public string ResetLink()
    {
        return baseUrl + "/reset";
    }
}
