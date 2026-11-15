using System.ComponentModel.DataAnnotations;
using FluentValidation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using OtpNet;

public class SignupModel
{
    // ruleid: jgates.csharp.password-min-length-below-8
    [StringLength(100, MinimumLength = 4)]
    public string Password { get; set; }

    // ruleid: jgates.csharp.password-min-length-below-8
    [MinLength(6)]
    public string NewPassword { get; set; }

    // ok: jgates.csharp.password-min-length-below-8
    [StringLength(128, MinimumLength = 12)]
    public string ConfirmPassword { get; set; }

    // ok: jgates.csharp.password-min-length-below-8
    [MinLength(2)]
    public string DisplayName { get; set; }

    // ruleid: jgates.csharp.password-max-length-below-64
    [StringLength(20)]
    public string OldPassword { get; set; }

    // ruleid: jgates.csharp.password-max-length-below-64
    [MaxLength(32)]
    public string Senha { get; set; }

    // ok: jgates.csharp.password-max-length-below-64
    [StringLength(128)]
    public string LoginPassword { get; set; }

    // ok: jgates.csharp.password-max-length-below-64
    [MaxLength(30)]
    public string Nickname { get; set; }

    // ruleid: jgates.csharp.secret-question-present
    public string SecretQuestion { get; set; }

    // ruleid: jgates.csharp.secret-question-present
    public string SecurityAnswer { get; set; }

    // ok: jgates.csharp.secret-question-present
    public string RecoveryEmail { get; set; }

    // ok: jgates.csharp.secret-question-present
    public string Question { get; set; }
}

public class SignupValidator : AbstractValidator<SignupModel>
{
    public SignupValidator()
    {
        // ruleid: jgates.csharp.password-min-length-below-8
        RuleFor(x => x.Password).NotEmpty().MinimumLength(5);
        // ruleid: jgates.csharp.password-min-length-below-8
        RuleFor(x => x.NewPassword).Length(6, 128);
        // ok: jgates.csharp.password-min-length-below-8
        RuleFor(x => x.ConfirmPassword).MinimumLength(12);
        // ok: jgates.csharp.password-min-length-below-8
        RuleFor(x => x.DisplayName).MinimumLength(2);

        // ruleid: jgates.csharp.password-max-length-below-64
        RuleFor(x => x.OldPassword).MaximumLength(30);
        // ruleid: jgates.csharp.password-max-length-below-64
        RuleFor(x => x.Senha).Length(8, 40);
        // ok: jgates.csharp.password-max-length-below-64
        RuleFor(x => x.LoginPassword).MaximumLength(128);
        // ok: jgates.csharp.password-max-length-below-64
        RuleFor(x => x.Nickname).MaximumLength(20);
    }
}

public class PasswordPolicy
{
    public bool TooShort(string password)
    {
        // ruleid: jgates.csharp.password-min-length-below-8
        return password.Length < 6;
    }

    public bool TooLong(string password)
    {
        // ruleid: jgates.csharp.password-max-length-below-64
        return password.Length > 20;
    }

    public bool Acceptable(string password)
    {
        // ok: jgates.csharp.password-min-length-below-8
        if (password.Length < 12) return false;
        // ok: jgates.csharp.password-max-length-below-64
        return password.Length <= 128;
    }

    public bool NameFits(string name)
    {
        // ok: jgates.csharp.password-min-length-below-8
        return name.Length < 3;
    }

    public void Configure(IdentityOptions options)
    {
        // ruleid: jgates.csharp.password-min-length-below-8
        options.Password.RequiredLength = 6;
        // ok: jgates.csharp.password-min-length-below-8
        options.Password.RequiredLength = 12;

        // ruleid: jgates.csharp.password-composition-rule
        options.Password.RequireDigit = true;
        // ruleid: jgates.csharp.password-composition-rule
        options.Password.RequireUppercase = true;
        // ok: jgates.csharp.password-composition-rule
        options.Password.RequireDigit = false;
        // ok: jgates.csharp.password-composition-rule
        options.Password.RequireNonAlphanumeric = false;
    }
}

public class HashingService
{
    private readonly IPasswordHasher<object> hasher;

    public string Hash(string password)
    {
        var normalized = password.ToLower();
        // ruleid: jgates.csharp.password-transformed-before-verify
        return BCrypt.Net.BCrypt.HashPassword(normalized);
    }

    public bool Check(string password, string stored)
    {
        // ruleid: jgates.csharp.password-transformed-before-verify
        return BCrypt.Net.BCrypt.Verify(password.Substring(0, 10), stored);
    }

    public string HashIdentity(string password, object user)
    {
        var cut = password.ToUpperInvariant();
        // ruleid: jgates.csharp.password-transformed-before-verify
        return hasher.HashPassword(user, cut);
    }

    public string HashExact(string password)
    {
        // ok: jgates.csharp.password-transformed-before-verify
        return BCrypt.Net.BCrypt.HashPassword(password);
    }

    public string HashEmail(string email)
    {
        var lower = email.ToLower();
        // ok: jgates.csharp.password-transformed-before-verify
        return BCrypt.Net.BCrypt.HashPassword(lower);
    }
}

public class Account
{
    public string Role { get; set; }
    public bool IsAdmin { get; set; }
}

public class AccountsController : Controller
{
    private readonly UserManager<Account> users;

    public IActionResult Promote(string role)
    {
        var account = new Account();
        // ruleid: jgates.csharp.client-controlled-privilege
        account.Role = role;
        return Ok(account);
    }

    public IActionResult MakeAdmin()
    {
        // ruleid: jgates.csharp.client-controlled-privilege
        var account = new Account { IsAdmin = bool.Parse(Request.Form["admin"]) };
        return Ok(account);
    }

    public IActionResult Register(string requestedRole)
    {
        var account = new Account();
        // ruleid: jgates.csharp.client-controlled-privilege
        users.AddToRoleAsync(account, requestedRole);
        return Ok(account);
    }

    public IActionResult Fixed(string name)
    {
        var account = new Account();
        // ok: jgates.csharp.client-controlled-privilege
        account.Role = "member";
        // ok: jgates.csharp.client-controlled-privilege
        users.AddToRoleAsync(account, "member");
        return Ok(name);
    }
}

public static class Startup
{
    public static void Authorization(AuthorizationOptions options, WebApplication app)
    {
        // ruleid: jgates.csharp.permit-all-requests
        options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAssertion(ctx => true).Build();
        // ruleid: jgates.csharp.permit-all-requests
        app.MapControllers().AllowAnonymous();
        // ok: jgates.csharp.permit-all-requests
        options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
        // ok: jgates.csharp.permit-all-requests
        app.MapControllers().RequireAuthorization();
    }
}

public class OneTimePasswords
{
    public Totp Wide(byte[] key)
    {
        // ruleid: jgates.csharp.totp-window-too-wide
        return new Totp(key, step: 300);
    }

    public bool Verify(Totp totp, string code)
    {
        long step;
        // ruleid: jgates.csharp.totp-window-too-wide
        return totp.VerifyTotp(code, out step, new VerificationWindow(previous: 5, future: 5));
    }

    public Totp Standard(byte[] key)
    {
        // ok: jgates.csharp.totp-window-too-wide
        return new Totp(key, step: 30);
    }

    public bool VerifyTight(Totp totp, string code)
    {
        long step;
        // ok: jgates.csharp.totp-window-too-wide
        return totp.VerifyTotp(code, out step, new VerificationWindow(previous: 1, future: 1));
    }
}
