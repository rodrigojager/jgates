using System;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

public class AccountController : Controller
{
    private readonly ILogger<AccountController> _logger;

    public AccountController(ILogger<AccountController> logger)
    {
        _logger = logger;
    }

    public IActionResult SignIn(string user, string password)
    {
        _logger.LogInformation("sign in for {User} with {Password}", user, password);
        return Ok();
    }

    public IActionResult Audit()
    {
        _logger.LogInformation("auth header {Header}", Request.Headers["Authorization"]);
        return Ok();
    }

    public IActionResult Load()
    {
        try
        {
            Refresh();
            return Ok();
        }
        catch (Exception ex)
        {
            return Content(ex.StackTrace);
        }
    }

    public IActionResult Save()
    {
        try
        {
            Refresh();
            return Ok();
        }
        catch (Exception ex)
        {
            return BadRequest(ex.Message);
        }
    }

    public void Cleanup()
    {
        try { Refresh(); } catch { }
    }

    public async Task Fetch()
    {
        var client = new HttpClient();
        var target = ValidateUrl(Request.Query["url"].ToString());
        await client.GetAsync(target);
    }

    private void Refresh() { }
}
