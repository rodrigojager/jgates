using System;
using System.Net.Http;
using System.Net.Security;
using System.Security.Authentication;
using Microsoft.IdentityModel.Tokens;

public class TokensTransportService
{
    public TokenValidationParameters BuildParameters()
    {
        return new TokenValidationParameters { ValidAlgorithms = new[] { "none" } };
    }

    public object ReadKeyUrl(System.IdentityModel.Tokens.Jwt.JwtSecurityToken token)
    {
        return token.Header["jku"];
    }

    public string LoginUrl()
    {
        return "https://idp.example.com/authorize?response_type=code&client_id=abc&redirect_uri=https://app.example.com/cb";
    }

    public void Connect(SslStream stream, string host)
    {
        stream.AuthenticateAsClient(host, null, SslProtocols.Tls11, true);
    }

    public CipherSuitesPolicy Suites()
    {
        return new CipherSuitesPolicy(new[] { TlsCipherSuite.TLS_RSA_WITH_RC4_128_SHA });
    }

    public async System.Threading.Tasks.Task<string> Fetch(HttpClient client)
    {
        return await client.GetStringAsync("http://api.example.com/items");
    }

    public SslServerAuthenticationOptions ServerOptions()
    {
        return new SslServerAuthenticationOptions
        {
            ClientCertificateRequired = true,
            RemoteCertificateValidationCallback = (sender, cert, chain, errors) => true
        };
    }
}
