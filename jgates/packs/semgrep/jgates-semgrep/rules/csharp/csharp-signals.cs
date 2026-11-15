// Fixture of csharp-signals.yaml: one match and one non-match per rule. Never compiled or run.

// ruleid: jgates.csharp.uses-graphql
using HotChocolate.Types;
// ruleid: jgates.csharp.uses-graphql
using GraphQL;
// ok: jgates.csharp.uses-graphql
using Example.GraphQLNotes;

// ruleid: jgates.csharp.uses-websocket
using System.Net.WebSockets;
// ruleid: jgates.csharp.uses-websocket
using Microsoft.AspNetCore.SignalR;
// ok: jgates.csharp.uses-websocket
using Example.WebSocketNotes;

// ruleid: jgates.csharp.uses-webrtc
using SIPSorcery.Net;
// ruleid: jgates.csharp.uses-webrtc
using Microsoft.MixedReality.WebRTC;
// ok: jgates.csharp.uses-webrtc
using Example.WebRtcNotes;

// ruleid: jgates.csharp.uses-oauth-client
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
// ruleid: jgates.csharp.uses-oauth-client
using IdentityModel.Client;
// ok: jgates.csharp.uses-oauth-client
using Example.OAuthNotes;

// ruleid: jgates.csharp.uses-oauth-authorization-server
using OpenIddict.Server;
// ruleid: jgates.csharp.uses-oauth-authorization-server
using Duende.IdentityServer.Models;
// ok: jgates.csharp.uses-oauth-authorization-server
using Example.OpenIddictNotes;

// ruleid: jgates.csharp.uses-jwt
using System.IdentityModel.Tokens.Jwt;
// ruleid: jgates.csharp.uses-jwt
using Microsoft.AspNetCore.Authentication.JwtBearer;
// ok: jgates.csharp.uses-jwt
using Example.JwtNotes;

// ruleid: jgates.csharp.uses-saml
using Sustainsys.Saml2.AspNetCore2;
// ruleid: jgates.csharp.uses-saml
using ITfoxtec.Identity.Saml2;
// ok: jgates.csharp.uses-saml
using Example.SamlNotes;

// ruleid: jgates.csharp.uses-totp
using OtpNet;
// ok: jgates.csharp.uses-totp
using Example.OtpNotes;

// ruleid: jgates.csharp.uses-ldap
using System.DirectoryServices.Protocols;
// ruleid: jgates.csharp.uses-ldap
using Novell.Directory.Ldap;
// ok: jgates.csharp.uses-ldap
using Example.LdapNotes;

// ruleid: jgates.csharp.uses-xml
using System.Xml.Linq;
// ruleid: jgates.csharp.uses-xml
using System.Xml;
// ok: jgates.csharp.uses-xml
using Example.XmlNotes;

// ruleid: jgates.csharp.uses-memcache
using Enyim.Caching;
// ok: jgates.csharp.uses-memcache
using Example.MemcacheNotes;

// ruleid: jgates.csharp.uses-mail
using System.Net.Mail;
// ruleid: jgates.csharp.uses-mail
using MailKit.Net.Smtp;
// ok: jgates.csharp.uses-mail
using Example.MailNotes;

// ruleid: jgates.csharp.uses-templates
using RazorLight;
// ruleid: jgates.csharp.uses-templates
using Scriban;
// ok: jgates.csharp.uses-templates
using Example.TemplateNotes;

// ruleid: jgates.csharp.uses-file-upload
using tusdotnet.Models;
// ok: jgates.csharp.uses-file-upload
using Example.UploadNotes;

// ruleid: jgates.csharp.uses-archives
using System.IO.Compression;
// ruleid: jgates.csharp.uses-archives
using SharpCompress.Archives;
// ok: jgates.csharp.uses-archives
using Example.ArchiveNotes;

// ruleid: jgates.csharp.uses-browser-dom
using Microsoft.JSInterop;
// ruleid: jgates.csharp.uses-browser-dom
using System.Runtime.InteropServices.JavaScript;
// ok: jgates.csharp.uses-browser-dom
using Example.BrowserNotes;

// ruleid: jgates.csharp.uses-xml
global using System.Xml.Serialization;
// ruleid: jgates.csharp.uses-jwt
using Tokens = Microsoft.IdentityModel.Tokens;
// ruleid: jgates.csharp.uses-archives
using static System.IO.Compression.ZipFile;

namespace Example
{
    public class Notes
    {
        // ok: jgates.csharp.uses-graphql
        public const string NoteGraphQL = "using HotChocolate.Types; is only mentioned here";

        // ok: jgates.csharp.uses-websocket
        public const string NoteWs = "using System.Net.WebSockets;"; // not a directive

        public void Totp(object users, object user, object signIn)
        {
            // ruleid: jgates.csharp.uses-totp
            var key = users.GetAuthenticatorKeyAsync(user);
            // ruleid: jgates.csharp.uses-totp
            var ok = users.VerifyTwoFactorTokenAsync(user, "Authenticator", "123456");
            // ruleid: jgates.csharp.uses-totp
            var result = signIn.TwoFactorAuthenticatorSignInAsync("123456", false, false);
            // ok: jgates.csharp.uses-totp
            var name = users.GetUserNameAsync(user);
        }

        public void Xml(string text, object builder)
        {
            // ruleid: jgates.csharp.uses-xml
            var doc = new XmlDocument();
            // ruleid: jgates.csharp.uses-xml
            var x = XDocument.Parse(text);
            // ruleid: jgates.csharp.uses-xml
            builder.AddXmlSerializerFormatters();
            // ok: jgates.csharp.uses-xml
            var s = text.Trim();
        }

        public void Templates(object builder)
        {
            // ruleid: jgates.csharp.uses-templates
            builder.AddControllersWithViews();
            // ruleid: jgates.csharp.uses-templates
            builder.MapRazorPages();
            // ruleid: jgates.csharp.uses-templates
            return View(model);
            // ok: jgates.csharp.uses-templates
            builder.AddControllers();
        }

        // ruleid: jgates.csharp.uses-file-upload
        public void Upload(IFormFile avatar)
        {
            // ruleid: jgates.csharp.uses-file-upload
            var files = Request.Form.Files;
            // ruleid: jgates.csharp.uses-file-upload
            var reader = new MultipartReader(boundary, stream);
            // ok: jgates.csharp.uses-file-upload
            var name = Request.Form["name"];
        }
    }
}
