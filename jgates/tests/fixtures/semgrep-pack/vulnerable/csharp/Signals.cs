using System.Diagnostics.CodeAnalysis;
using System.IO.Compression;
using System.Net.Mail;
using System.Net.WebSockets;
using System.Runtime.InteropServices.JavaScript;
using System.Xml.Linq;
using HotChocolate.Types;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Http;
using Microsoft.MixedReality.WebRTC;
using Novell.Directory.Ldap;
using OpenIddict.Server;
using OtpNet;
using RazorLight;
using Sustainsys.Saml2.AspNetCore2;
using Enyim.Caching;

// A service that touches every technology of the signal list that C# can show.
namespace Example.Signals
{
    public class Service
    {
        public void Upload(IFormFile avatar)
        {
            var archive = new ZipArchive(avatar.OpenReadStream());
            var document = XDocument.Parse("<a/>");
        }
    }
}
