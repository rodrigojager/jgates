package fixtures

import (
	"context"
	"database/sql"
	"fmt"
	"os/exec"
)

func sqlCases(ctx context.Context, db *sql.DB, name string, id int) {
	// ruleid: jgates.go.sql-string-building
	db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))
	// ruleid: jgates.go.sql-string-building
	db.Exec("DELETE FROM users WHERE name = '" + name + "'")
	// ruleid: jgates.go.sql-string-building
	db.QueryContext(ctx, fmt.Sprintf("SELECT * FROM users WHERE id = %d", id))
	// ruleid: jgates.go.sql-string-building
	db.QueryRow("SELECT email FROM users WHERE name = '" + name + "'")
	// ok: jgates.go.sql-string-building
	db.Query("SELECT * FROM users WHERE name = ?", name)
	// ok: jgates.go.sql-string-building
	db.Exec("DELETE FROM users WHERE id = $1", id)
	// ok: jgates.go.sql-string-building
	db.QueryContext(ctx, "SELECT * FROM users WHERE id = ?", id)
	// ok: jgates.go.sql-string-building
	db.Exec("INSERT INTO log (note) VALUES (?)", fmt.Sprintf("seen %d", id))
	// ok: jgates.go.sql-string-building
	db.Query(fmt.Sprintf("SELECT 1"))
}

func sqlxCases(ctx context.Context, db *sqlx.DB, out *[]User, table string) {
	// ruleid: jgates.go.sql-string-building
	db.Select(out, fmt.Sprintf("SELECT * FROM %s", table))
	// ruleid: jgates.go.sql-string-building
	db.GetContext(ctx, out, "SELECT * FROM "+table+" LIMIT 1")
	// ok: jgates.go.sql-string-building
	db.Select(out, "SELECT * FROM users WHERE active = ?", true)
}

func gormCases(db *gorm.DB, name string) {
	// ruleid: jgates.go.sql-string-building
	db.Raw(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))
	// ok: jgates.go.sql-string-building
	db.Raw("SELECT * FROM users WHERE name = ?", name)
}

func commandCases(ctx context.Context, dir string, tool string, script string) {
	// ruleid: jgates.go.os-command-injection
	exec.Command("sh", "-c", "ls "+dir)
	// ruleid: jgates.go.os-command-injection
	exec.Command(tool, "--version")
	// ruleid: jgates.go.os-command-injection
	exec.CommandContext(ctx, "bash", "-c", script)
	// ruleid: jgates.go.os-command-injection
	exec.Command("cmd", "/C", script)
	// ok: jgates.go.os-command-injection
	exec.Command("ls", "-l", dir)
	// ok: jgates.go.os-command-injection
	exec.Command("git", "status")
	// ok: jgates.go.os-command-injection
	exec.CommandContext(ctx, "tar", "-xf", script)
	// ok: jgates.go.os-command-injection
	exec.Command("sh", "-c", "echo done")
}
