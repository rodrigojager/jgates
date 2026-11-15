using System;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Security.Authentication;
using Microsoft.IdentityModel.Tokens;

public class TokensTransportSamples
{
    public void AlgorithmSamples(System.IdentityModel.Tokens.Jwt.JwtSecurityToken token, string jwt, byte[] key)
    {
        // ruleid: jgates.csharp.jwt-algorithm-not-restricted
        var a = new TokenValidationParameters { ValidAlgorithms = new[] { "none" } };
        var p = new TokenValidationParameters();
        // ruleid: jgates.csharp.jwt-algorithm-not-restricted
        p.ValidAlgorithms = new[] { SecurityAlgorithms.None, SecurityAlgorithms.HmacSha256 };
        // ruleid: jgates.csharp.jwt-algorithm-not-restricted
        p.ValidAlgorithms = new[] { token.Header.Alg };
        // ruleid: jgates.csharp.jwt-algorithm-not-restricted
        var d = Jose.JWT.Decode(jwt, key, Jose.JwsAlgorithm.none);
        // ok: jgates.csharp.jwt-algorithm-not-restricted
        var b = new TokenValidationParameters { ValidAlgorithms = new[] { SecurityAlgorithms.RsaSha256 } };
        // ok: jgates.csharp.jwt-algorithm-not-restricted
        var e = Jose.JWT.Decode(jwt, key, Jose.JwsAlgorithm.HS256);
    }

    public void KeySamples(System.IdentityModel.Tokens.Jwt.JwtSecurityToken token)
    {
        // ruleid: jgates.csharp.jwt-key-from-token-header
        var a = token.Header["jku"];
        // ruleid: jgates.csharp.jwt-key-from-token-header
        token.Header.TryGetValue("x5u", out var url);
        // ok: jgates.csharp.jwt-key-from-token-header
        var kid = token.Header.Kid;
        // ok: jgates.csharp.jwt-key-from-token-header
        var typ = token.Header["typ"];
    }

    public void OAuthSamples(string clientId, string state, string challenge, IdentityModel.Client.RequestUrl requestUrl)
    {
        // ruleid: jgates.csharp.oauth-request-without-state
        var a = "https://idp.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https://app.example.com/cb";
        // ruleid: jgates.csharp.oauth-request-without-state
        var b = $"https://idp.example.com/authorize?client_id={clientId}&response_type=code";
        // ruleid: jgates.csharp.oauth-request-without-state
        var c = requestUrl.CreateAuthorizeUrl(clientId: clientId, responseType: "code", scope: "openid");
        // ok: jgates.csharp.oauth-request-without-state
        var d = "https://idp.example.com/authorize?response_type=code&client_id=abc&state=" + state;
        // ok: jgates.csharp.oauth-request-without-state
        var e = $"https://idp.example.com/authorize?client_id={clientId}&response_type=code&code_challenge={challenge}";
        // ok: jgates.csharp.oauth-request-without-state
        var f = requestUrl.CreateAuthorizeUrl(clientId: clientId, responseType: "code", state: state, codeChallenge: challenge);
    }

    public void ProtocolSamples(System.Net.Security.SslStream stream, string host)
    {
        // ruleid: jgates.csharp.tls-old-protocol-version
        stream.AuthenticateAsClient(host, null, SslProtocols.Tls11, true);
        // ruleid: jgates.csharp.tls-old-protocol-version
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Ssl3 | SecurityProtocolType.Tls12;
        // ruleid: jgates.csharp.tls-old-protocol-version
        var o = new SslClientAuthenticationOptions { EnabledSslProtocols = SslProtocols.Tls | SslProtocols.Tls12 };
        // ok: jgates.csharp.tls-old-protocol-version
        stream.AuthenticateAsClient(host, null, SslProtocols.Tls12 | SslProtocols.Tls13, true);
        // ok: jgates.csharp.tls-old-protocol-version
        var p = new SslClientAuthenticationOptions { EnabledSslProtocols = SslProtocols.None };
    }

    public void CipherSamples()
    {
        // ruleid: jgates.csharp.tls-weak-cipher-suite
        var a = new System.Net.Security.CipherSuitesPolicy(new[] { System.Net.Security.TlsCipherSuite.TLS_RSA_WITH_RC4_128_SHA });
        // ruleid: jgates.csharp.tls-weak-cipher-suite
        var b = new System.Net.Security.CipherSuitesPolicy(new[] { TlsCipherSuite.TLS_RSA_WITH_3DES_EDE_CBC_SHA, TlsCipherSuite.TLS_AES_256_GCM_SHA384 });
        // ok: jgates.csharp.tls-weak-cipher-suite
        var c = new System.Net.Security.CipherSuitesPolicy(new[] { TlsCipherSuite.TLS_AES_256_GCM_SHA384 });
        // ok: jgates.csharp.tls-weak-cipher-suite
        var d = new System.Net.Security.CipherSuitesPolicy(new[] { TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, TlsCipherSuite.TLS_CHACHA20_POLY1305_SHA256 });
    }

    public async System.Threading.Tasks.Task UrlSamples(HttpClient client, WebClient web)
    {
        // ruleid: jgates.csharp.cleartext-http-url
        var a = await client.GetStringAsync("http://api.example.com/items");
        // ruleid: jgates.csharp.cleartext-http-url
        var b = await client.PostAsync("http://api.example.com/items", null);
        // ruleid: jgates.csharp.cleartext-http-url
        var c = WebRequest.Create("ftp://files.example.com/report.csv");
        // ruleid: jgates.csharp.cleartext-http-url
        var d = web.DownloadString("http://feeds.example.com/rss");
        // ruleid: jgates.csharp.cleartext-http-url
        client.BaseAddress = new Uri("http://api.example.com/");
        // ok: jgates.csharp.cleartext-http-url
        var e = await client.GetStringAsync("https://api.example.com/items");
        // ok: jgates.csharp.cleartext-http-url
        var f = await client.GetStringAsync("http://localhost:5000/health");
        // ok: jgates.csharp.cleartext-http-url
        var g = await client.GetStringAsync("http://127.0.0.1:8080/ping");
        // ok: jgates.csharp.cleartext-http-url
        var h = WebRequest.Create("https://files.example.com/report.csv");
    }

    public void MutualTlsSamples()
    {
        // ruleid: jgates.csharp.mtls-client-certificate-not-verified
        var a = new Microsoft.AspNetCore.Server.Kestrel.Https.HttpsConnectionAdapterOptions { ClientCertificateValidation = (cert, chain, errors) => true };
        var o = new Microsoft.AspNetCore.Server.Kestrel.Https.HttpsConnectionAdapterOptions();
        // ruleid: jgates.csharp.mtls-client-certificate-not-verified
        o.ClientCertificateValidation = (_, _, _) => true;
        var s = new SslServerAuthenticationOptions
        {
            // ruleid: jgates.csharp.mtls-client-certificate-not-verified
            ClientCertificateRequired = true,
            RemoteCertificateValidationCallback = (sender, cert, chain, errors) => true
        };
        // ok: jgates.csharp.mtls-client-certificate-not-verified
        o.ClientCertificateValidation = (cert, chain, errors) => errors == SslPolicyErrors.None;
        // ok: jgates.csharp.mtls-client-certificate-not-verified
        var t = new SslServerAuthenticationOptions
        {
            ClientCertificateRequired = true,
            RemoteCertificateValidationCallback = (sender, cert, chain, errors) => errors == SslPolicyErrors.None
        };
    }
}
