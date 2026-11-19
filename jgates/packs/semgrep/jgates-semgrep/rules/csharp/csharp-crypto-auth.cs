using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;

public class CryptoAuthSamples
{
    public void HashSamples(byte[] data)
    {
        // ruleid: jgates.csharp.weak-hash
        var a = MD5.Create();
        // ruleid: jgates.csharp.weak-hash
        var b = SHA1.Create();
        // ruleid: jgates.csharp.weak-hash
        var c = new MD5CryptoServiceProvider();
        // ruleid: jgates.csharp.weak-hash
        var d = SHA1.HashData(data);
        // ok: jgates.csharp.weak-hash
        var e = SHA256.Create();
        // ok: jgates.csharp.weak-hash
        var f = SHA256.HashData(data);
    }

    public void CipherSamples(SymmetricAlgorithm aes)
    {
        // ruleid: jgates.csharp.weak-cipher
        var a = DES.Create();
        // ruleid: jgates.csharp.weak-cipher
        var b = new TripleDESCryptoServiceProvider();
        // ruleid: jgates.csharp.weak-cipher
        aes.Mode = CipherMode.ECB;
        // ok: jgates.csharp.weak-cipher
        var c = Aes.Create();
        // ok: jgates.csharp.weak-cipher
        aes.Mode = CipherMode.CBC;
    }

    public void TlsSamples()
    {
        // ruleid: jgates.csharp.tls-verification-disabled
        System.Net.ServicePointManager.ServerCertificateValidationCallback = (sender, cert, chain, errors) => true;
        var handler = new HttpClientHandler();
        // ruleid: jgates.csharp.tls-verification-disabled
        handler.ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => true;
        // ruleid: jgates.csharp.tls-verification-disabled
        handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        // ok: jgates.csharp.tls-verification-disabled
        handler.ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => errors == SslPolicyErrors.None;
        // ok: jgates.csharp.tls-verification-disabled
        var plain = new HttpClientHandler();
    }

    public void TokenSamples()
    {
        // ruleid: jgates.csharp.token-validation-disabled
        var a = new TokenValidationParameters { ValidateIssuerSigningKey = false };
        var p = new TokenValidationParameters();
        // ruleid: jgates.csharp.token-validation-disabled
        p.ValidateLifetime = false;
        // ruleid: jgates.csharp.token-validation-disabled
        p.ValidateAudience = false;
        // ok: jgates.csharp.token-validation-disabled
        var b = new TokenValidationParameters { ValidateIssuerSigningKey = true, ValidateLifetime = true };
        // ok: jgates.csharp.token-validation-disabled
        p.ValidateIssuer = true;
    }
}
