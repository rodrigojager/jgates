using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization.Formatters.Binary;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Xml;
using Microsoft.AspNetCore.Html;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Rendering;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;

public class LookupController : Controller
{
    private readonly SqlConnection conn = new SqlConnection("Server=.;Database=app");
    private readonly HttpClient client = new HttpClient();

    public IActionResult Find(string name)
    {
        var cmd = new SqlCommand("SELECT * FROM Users WHERE Name = '" + name + "'", conn);
        Process.Start(name);
        var hash = MD5.Create().ComputeHash(System.Text.Encoding.UTF8.GetBytes(name));
        return Ok(cmd.ExecuteScalar() + hash.Length.ToString());
    }

    public async Task<IActionResult> Proxy(string url)
    {
        return Ok(await client.GetStringAsync(url));
    }

    public IActionResult Read(string path)
    {
        return Ok(System.IO.File.ReadAllText(path));
    }

    public async Task Echo(string text)
    {
        await Response.WriteAsync(text);
    }

    private IHtmlContent Banner(IHtmlHelper Html, string title)
    {
        return Html.Raw("<h1>" + title + "</h1>");
    }

    public object Restore(Stream input)
    {
        return new BinaryFormatter().Deserialize(input);
    }

    public static void Configure()
    {
        var a = DES.Create();
        System.Net.ServicePointManager.ServerCertificateValidationCallback = (sender, cert, chain, errors) => true;
        var p = new TokenValidationParameters { ValidateIssuerSigningKey = false };
        var s = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.All };
        var x = new XmlReaderSettings { DtdProcessing = DtdProcessing.Parse };
    }
}
