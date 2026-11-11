using Microsoft.EntityFrameworkCore;

namespace App;

public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string? Email { get; set; }
}

public class AppDbContext : DbContext
{
    public DbSet<User> Users => Set<User>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlite("Data Source=app.db");
}
