using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using OtpNet;

public class SignupModel
{
    [StringLength(128, MinimumLength = 12)]
    public string Password { get; set; }

    public string Email { get; set; }
    public string RecoveryEmail { get; set; }
}

public class Account
{
    public string Role { get; set; }
}

public class AccountsController : Controller
{
    public IActionResult Hash(string password)
    {
        return Ok(BCrypt.Net.BCrypt.HashPassword(password));
    }

    public IActionResult Promote(string name)
    {
        var account = new Account();
        account.Role = "member";
        return Ok(account);
    }
}

public static class Startup
{
    public static void Configure(IdentityOptions options, AuthorizationOptions authz, WebApplication app)
    {
        options.Password.RequiredLength = 12;
        authz.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
    }

    public static Totp Totp(byte[] key)
    {
        return new Totp(key, step: 30);
    }
}
