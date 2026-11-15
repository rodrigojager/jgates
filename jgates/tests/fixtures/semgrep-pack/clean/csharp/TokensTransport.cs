using System;
using System.Net.Http;
using System.Net.Security;
using System.Security.Authentication;
using Microsoft.IdentityModel.Tokens;

public class TokensTransportService
{
    public TokenValidationParameters BuildParameters()
    {
        return new TokenValidationParameters { ValidAlgorithms = new[] { SecurityAlgorithms.RsaSha256 } };
    }

    public object ReadKeyUrl(System.IdentityModel.Tokens.Jwt.JwtSecurityToken token)
    {
        return token.Header.Kid;
    }

    public string LoginUrl(string state, string challenge)
    {
        return "https://idp.example.com/authorize?response_type=code&client_id=abc&state=" + Uri.EscapeDataString(state) + "&code_challenge=" + Uri.EscapeDataString(challenge);
    }

    public void Connect(SslStream stream, string host)
    {
        stream.AuthenticateAsClient(host, null, SslProtocols.Tls12 | SslProtocols.Tls13, true);
    }

    public CipherSuitesPolicy Suites()
    {
        return new CipherSuitesPolicy(new[] { TlsCipherSuite.TLS_AES_256_GCM_SHA384 });
    }

    public async System.Threading.Tasks.Task<string> Fetch(HttpClient client)
    {
        return await client.GetStringAsync("https://api.example.com/items");
    }

    public SslServerAuthenticationOptions ServerOptions()
    {
        return new SslServerAuthenticationOptions
        {
            ClientCertificateRequired = true,
            RemoteCertificateValidationCallback = (sender, cert, chain, errors) => errors == SslPolicyErrors.None
        };
    }
}
