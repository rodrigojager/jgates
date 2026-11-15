using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

public class SettingsController : Controller
{
    public void Configure(WebApplication app, IServiceCollection services, KestrelServerOptions kestrel)
    {
        if (app.Environment.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
        }
        else
        {
            app.UseExceptionHandler("/error");
        }
        app.UseStaticFiles();
        kestrel.AddServerHeader = false;
    }

    public async Task<IActionResult> Edit(User user)
    {
        await TryUpdateModelAsync(user, "", u => u.Name, u => u.Email);
        return Ok();
    }
}
