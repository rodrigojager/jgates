using System.Data.SqlClient;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Threading.Tasks;
using System.Xml;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;

public class LookupController : Controller
{
    private readonly SqlConnection conn = new SqlConnection("Server=.;Database=app");
    private readonly HttpClient client = new HttpClient();

    public IActionResult Find(string name)
    {
        var cmd = new SqlCommand("SELECT * FROM Users WHERE Name = @name", conn);
        cmd.Parameters.AddWithValue("@name", name);
        var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(name));
        return Ok(cmd.ExecuteScalar() + hash.Length.ToString());
    }

    public async Task<IActionResult> Status()
    {
        return Ok(await client.GetStringAsync("https://api.example.com/status"));
    }

    public IActionResult Read(string path)
    {
        return Ok(System.IO.File.ReadAllText(Path.GetFileName(path)));
    }

    public async Task Echo(string text)
    {
        await Response.WriteAsync(HtmlEncoder.Default.Encode(text));
    }

    public static void Configure()
    {
        var a = Aes.Create();
        var p = new TokenValidationParameters { ValidateIssuerSigningKey = true, ValidateLifetime = true };
        var s = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.None };
        var x = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit };
    }
}
