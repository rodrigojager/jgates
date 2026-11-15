using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

public class SettingsController : Controller
{
    public void Configure(WebApplication app, IServiceCollection services, KestrelServerOptions kestrel)
    {
        app.UseDeveloperExceptionPage();
        app.UseSwagger();
        app.UseDirectoryBrowser();
        kestrel.AddServerHeader = true;
    }

    public async Task<IActionResult> Edit(User user)
    {
        await TryUpdateModelAsync(user);
        return Ok();
    }
}
