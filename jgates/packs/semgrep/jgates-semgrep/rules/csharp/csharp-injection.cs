using System.Data.SqlClient;
using System.Diagnostics;
using Dapper;
using Microsoft.EntityFrameworkCore;

public class InjectionSamples
{
    public void SqlSamples(SqlConnection conn, DbContext db, string name, int id)
    {
        // ruleid: jgates.csharp.sql-string-building
        var a = new SqlCommand("SELECT * FROM Users WHERE Name = '" + name + "'", conn);
        // ruleid: jgates.csharp.sql-string-building
        var b = new SqlCommand($"SELECT * FROM Users WHERE Name = '{name}'", conn);
        // ruleid: jgates.csharp.sql-string-building
        a.CommandText = "DELETE FROM Users WHERE Name = '" + name + "'";
        // ruleid: jgates.csharp.sql-string-building
        conn.Query<User>("SELECT * FROM Users WHERE Name = '" + name + "'");
        // ruleid: jgates.csharp.sql-string-building
        db.Users.FromSqlRaw($"SELECT * FROM Users WHERE Name = '{name}'");
        // ruleid: jgates.csharp.sql-string-building
        db.Database.ExecuteSqlRaw("DELETE FROM Users WHERE Name = '" + name + "'");

        // ok: jgates.csharp.sql-string-building
        var c = new SqlCommand("SELECT * FROM Users WHERE Name = @name", conn);
        // ok: jgates.csharp.sql-string-building
        conn.Query<User>("SELECT * FROM Users WHERE Id = @id", new { id });
        // ok: jgates.csharp.sql-string-building
        db.Users.FromSqlInterpolated($"SELECT * FROM Users WHERE Name = {name}");
        // ok: jgates.csharp.sql-string-building
        db.Database.ExecuteSqlRaw("DELETE FROM Users WHERE Id = {0}", id);
    }

    public void ProcessSamples(string tool, string host)
    {
        // ruleid: jgates.csharp.os-command-injection
        Process.Start(tool);
        // ruleid: jgates.csharp.os-command-injection
        Process.Start(tool, "-v");
        // ruleid: jgates.csharp.os-command-injection
        var info = new ProcessStartInfo(tool);
        // ruleid: jgates.csharp.os-command-injection
        info.Arguments = "-c " + host;

        // ok: jgates.csharp.os-command-injection
        Process.Start("notepad.exe");
        // ok: jgates.csharp.os-command-injection
        var fixedInfo = new ProcessStartInfo("ping.exe");
        // ok: jgates.csharp.os-command-injection
        fixedInfo.FileName = "ping.exe";
    }
}
