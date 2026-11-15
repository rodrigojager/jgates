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
    public void Setup(IServiceCollection services, IApplicationBuilder app)
    {
        services.AddHsts(o => { o.MaxAge = TimeSpan.FromDays(30); });
        Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'";
        app.UseWebSockets(new WebSocketOptions { AllowedOrigins = { "*" } });
        services.AddGraphQLServer().AddQueryType<Query>().AllowIntrospection(true);
    }

    public async Task Stream(ClientWebSocket ws, CancellationToken ct)
    {
        await ws.ConnectAsync(new Uri("ws://feed.example.com/stream"), ct);
    }

    public IActionResult Go(string next)
    {
        return Redirect(next);
    }

    public string Caller()
    {
        return Request.Headers["X-Forwarded-For"];
    }

    public string ResetLink()
    {
        var host = Request.Host.Value;
        return "https://" + host + "/reset";
    }
}
