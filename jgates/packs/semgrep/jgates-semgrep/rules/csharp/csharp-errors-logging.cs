using System;
using System.Net.Http;
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;
using Serilog;

public class ErrorsLoggingFixtures : Controller
{
    private readonly ILogger<ErrorsLoggingFixtures> _logger;

    // ---- sensitive-data-logged ----

    public void LogBad1(string password, string user)
    {
        // ruleid: jgates.csharp.sensitive-data-logged
        _logger.LogInformation("login for {User} with {Password}", user, password);
    }

    public void LogBad2(string apiToken)
    {
        // ruleid: jgates.csharp.sensitive-data-logged
        Log.Debug("calling upstream", apiToken);
    }

    public void LogBad3(string clientSecret)
    {
        // ruleid: jgates.csharp.sensitive-data-logged
        _logger.LogWarning($"secret is {clientSecret}");
    }

    public void LogOk1(string password, string user)
    {
        // ok: jgates.csharp.sensitive-data-logged
        _logger.LogInformation("login for {User}", user);
    }

    public void LogOk2(string password, string user)
    {
        // ok: jgates.csharp.sensitive-data-logged
        Log.Information("password length {Length}", password.Length);
    }

    // ---- sensitive-data-logged-header ----

    public void HeaderBad1()
    {
        // ruleid: jgates.csharp.sensitive-data-logged-header
        _logger.LogInformation("auth header {H}", Request.Headers["Authorization"]);
    }

    public void HeaderBad2()
    {
        // ruleid: jgates.csharp.sensitive-data-logged-header
        _logger.LogDebug($"got {Request.Headers[HeaderNames.Authorization]}");
    }

    public void HeaderOk1()
    {
        // ok: jgates.csharp.sensitive-data-logged-header
        _logger.LogInformation("request to {Path}", Request.Path);
    }

    public void HeaderOk2()
    {
        // ok: jgates.csharp.sensitive-data-logged-header
        _logger.LogInformation("agent {A}", Request.Headers["User-Agent"]);
    }

    // ---- stack-trace-in-response ----

    public IActionResult TraceBad1()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            // ruleid: jgates.csharp.stack-trace-in-response
            return Content(ex.StackTrace);
        }
    }

    public async Task TraceBad2(HttpContext context)
    {
        try { Work(); }
        catch (Exception ex)
        {
            var text = ex.ToString();
            // ruleid: jgates.csharp.stack-trace-in-response
            await context.Response.WriteAsync(text);
        }
    }

    public IActionResult TraceBad3()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            // ruleid: jgates.csharp.stack-trace-in-response
            return StatusCode(500, new { detail = ex.StackTrace });
        }
    }

    public IActionResult TraceOk1()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            // ok: jgates.csharp.stack-trace-in-response
            _logger.LogError(ex, "work failed");
            return Problem("An error occurred.");
        }
    }

    public IActionResult TraceOk2()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            Log.Error(ex.StackTrace);
            // ok: jgates.csharp.stack-trace-in-response
            return StatusCode(500, "An error occurred.");
        }
    }

    // ---- error-detail-in-response ----

    public IActionResult DetailBad1()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            // ruleid: jgates.csharp.error-detail-in-response
            return BadRequest(ex.Message);
        }
    }

    public IActionResult DetailBad2()
    {
        try { Work(); return Ok(); }
        catch (Exception e)
        {
            // ruleid: jgates.csharp.error-detail-in-response
            return Content($"failed: {e.Message}");
        }
    }

    public async Task DetailBad3(HttpContext context)
    {
        try { Work(); }
        catch (Exception ex)
        {
            // ruleid: jgates.csharp.error-detail-in-response
            await context.Response.WriteAsync(ex.Message);
        }
    }

    public IActionResult DetailOk1()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            _logger.LogError(ex.Message);
            // ok: jgates.csharp.error-detail-in-response
            return BadRequest("The request could not be processed.");
        }
    }

    public IActionResult DetailOk2()
    {
        try { Work(); return Ok(); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "work failed");
            // ok: jgates.csharp.error-detail-in-response
            return Problem(detail: "Something went wrong.");
        }
    }

    // ---- swallowed-exception ----

    public void SwallowBad1()
    {
        // ruleid: jgates.csharp.swallowed-exception
        try { Work(); } catch { }
    }

    public void SwallowBad2()
    {
        // ruleid: jgates.csharp.swallowed-exception
        try
        {
            Work();
        }
        catch (Exception ex)
        {
        }
    }

    public void SwallowBad3()
    {
        // ruleid: jgates.csharp.swallowed-exception
        try { Work(); } catch (Exception) { }
    }

    public void SwallowOk1()
    {
        // ok: jgates.csharp.swallowed-exception
        try { Work(); } catch (Exception ex) { _logger.LogError(ex, "work failed"); }
    }

    public void SwallowOk2()
    {
        // ok: jgates.csharp.swallowed-exception
        try { Work(); } catch (OperationCanceledException) { }
    }

    public void SwallowOk3()
    {
        // ok: jgates.csharp.swallowed-exception
        try { Work(); } catch (Exception) { throw; }
    }

    public async Task RedirectBad1()
    {
        var client = new HttpClient();
        var target = Request.Query["url"].ToString();
        // ruleid: jgates.csharp.outbound-request-follows-redirects
        await client.GetAsync(target);
    }

    public async Task RedirectBad2(string url)
    {
        var client = new HttpClient();
        // ruleid: jgates.csharp.outbound-request-follows-redirects
        await client.GetStringAsync(url);
    }

    public async Task RedirectOk1()
    {
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        var client = new HttpClient(handler);
        // ok: jgates.csharp.outbound-request-follows-redirects
        await client.GetAsync(Request.Query["url"].ToString());
    }

    public async Task RedirectOk2(string url)
    {
        var handler = new HttpClientHandler();
        handler.AllowAutoRedirect = false;
        var client = new HttpClient(handler);
        // ok: jgates.csharp.outbound-request-follows-redirects
        await client.GetStringAsync(url);
    }

    public async Task RedirectOk3()
    {
        var client = new HttpClient();
        // ok: jgates.csharp.outbound-request-follows-redirects
        await client.GetAsync("https://service.example/status");
    }

    private void Work() { }
}
