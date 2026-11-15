using System;
using System.Threading.Tasks;
using Hangfire;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

public class ConfigurationSamples : Controller
{
    // debug-mode-enabled
    public void Debug(WebApplication app, IWebHostBuilder host, IHostEnvironment env, IServiceCollection services)
    {
        // ruleid: jgates.csharp.debug-mode-enabled
        app.UseDeveloperExceptionPage();
        // ruleid: jgates.csharp.debug-mode-enabled
        host.UseEnvironment("Development");
        // ruleid: jgates.csharp.debug-mode-enabled
        services.AddSignalR(o => { o.EnableDetailedErrors = true; });
        if (env.IsDevelopment())
        {
            // ok: jgates.csharp.debug-mode-enabled
            app.UseDeveloperExceptionPage();
        }
        else
        {
            // ok: jgates.csharp.debug-mode-enabled
            app.UseExceptionHandler("/error");
        }
    }

    // docs-or-monitoring-endpoint-exposed
    public void Docs(WebApplication app)
    {
        // ruleid: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.UseSwagger();
        // ruleid: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.UseSwaggerUI();
        // ruleid: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.MapPrometheusScrapingEndpoint();
        // ruleid: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.UseHangfireDashboard("/jobs");
        if (app.Environment.IsDevelopment())
        {
            // ok: jgates.csharp.docs-or-monitoring-endpoint-exposed
            app.UseSwagger();
            // ok: jgates.csharp.docs-or-monitoring-endpoint-exposed
            app.UseSwaggerUI();
        }
        // ok: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.MapPrometheusScrapingEndpoint().RequireAuthorization();
        // ok: jgates.csharp.docs-or-monitoring-endpoint-exposed
        app.UseHangfireDashboard("/jobs", new DashboardOptions { Authorization = new[] { new AdminFilter() } });
    }

    // directory-listing-enabled
    public void Listing(WebApplication app, IServiceCollection services)
    {
        // ruleid: jgates.csharp.directory-listing-enabled
        app.UseDirectoryBrowser();
        // ruleid: jgates.csharp.directory-listing-enabled
        services.AddDirectoryBrowser();
        // ruleid: jgates.csharp.directory-listing-enabled
        app.UseFileServer(enableDirectoryBrowsing: true);
        // ruleid: jgates.csharp.directory-listing-enabled
        var options = new FileServerOptions { EnableDirectoryBrowsing = true };
        // ok: jgates.csharp.directory-listing-enabled
        app.UseStaticFiles();
        // ok: jgates.csharp.directory-listing-enabled
        app.UseFileServer(enableDirectoryBrowsing: false);
    }

    // version-header-exposed
    public void Versions(IWebHostBuilder host, KestrelServerOptions kestrel)
    {
        // ruleid: jgates.csharp.version-header-exposed
        kestrel.AddServerHeader = true;
        // ruleid: jgates.csharp.version-header-exposed
        Response.Headers["X-Powered-By"] = "ASP.NET";
        // ruleid: jgates.csharp.version-header-exposed
        Response.Headers.Append("Server", "Kestrel 8.0");
        // ok: jgates.csharp.version-header-exposed
        kestrel.AddServerHeader = false;
        // ok: jgates.csharp.version-header-exposed
        Response.Headers["X-Request-Id"] = "abc";
        // ok: jgates.csharp.version-header-exposed
        Response.Headers.Remove("X-Powered-By");
    }

    // mass-assignment
    public async Task<IActionResult> Edit(User user, UserDto dto)
    {
        // ruleid: jgates.csharp.mass-assignment
        await TryUpdateModelAsync(user);
        // ruleid: jgates.csharp.mass-assignment
        await TryUpdateModelAsync(user, "");
        // ruleid: jgates.csharp.mass-assignment
        UpdateModel(user);
        // ok: jgates.csharp.mass-assignment
        await TryUpdateModelAsync(user, "", u => u.Name, u => u.Email);
        // ok: jgates.csharp.mass-assignment
        user.Name = dto.Name;
        return Ok();
    }
}
