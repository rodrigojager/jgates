use std::process::Command;

async fn find_user(pool: &sqlx::PgPool, name: &str) {
    // ruleid: jgates.rust.sql-string-building
    sqlx::query(&format!("SELECT * FROM users WHERE name = '{}'", name)).fetch_all(pool).await;
    let q = format!("DELETE FROM sessions WHERE token = '{}'", name);
    // ruleid: jgates.rust.sql-string-building
    sqlx::query(&q).fetch_all(pool).await;
    // ok: jgates.rust.sql-string-building
    sqlx::query("SELECT * FROM users WHERE name = $1").bind(name).fetch_all(pool).await;
    let label = format!("looking up {}", name);
    // ok: jgates.rust.sql-string-building
    sqlx::query("SELECT 1").execute(pool).await;
    log::info!("{}", label);
}

fn local_db(conn: &rusqlite::Connection, id: i64, name: &str) {
    let stmt = format!("DELETE FROM items WHERE id = {}", id);
    // ruleid: jgates.rust.sql-string-building
    conn.execute(&stmt, []).unwrap();
    let raw = String::from("SELECT * FROM items WHERE name = '") + name;
    // ruleid: jgates.rust.sql-string-building
    conn.prepare(&raw).unwrap();
    // ok: jgates.rust.sql-string-building
    conn.execute("DELETE FROM items WHERE id = ?1", [id]).unwrap();
    // ok: jgates.rust.sql-string-building
    conn.prepare("SELECT * FROM items WHERE name = ?1").unwrap();
}

fn with_diesel(conn: &mut PgConnection, id: i32) {
    // ruleid: jgates.rust.sql-string-building
    diesel::sql_query(format!("SELECT * FROM posts WHERE id = {}", id)).load::<Post>(conn).unwrap();
    // ok: jgates.rust.sql-string-building
    diesel::sql_query("SELECT * FROM posts WHERE id = $1").bind::<Integer, _>(id).load::<Post>(conn).unwrap();
}

fn run_shell(cmd: String, script: &str) {
    // ruleid: jgates.rust.os-command-injection
    Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
    // ruleid: jgates.rust.os-command-injection
    Command::new("bash").args(["-c", script]).output().unwrap();
    // ruleid: jgates.rust.os-command-injection
    Command::new("cmd").args(&["/C", &cmd]).output().unwrap();
    // ok: jgates.rust.os-command-injection
    Command::new("sh").arg("-c").arg("ls -l").output().unwrap();
    // ok: jgates.rust.os-command-injection
    Command::new("git").arg("-c").arg(&cmd).output().unwrap();
}

fn run_program(program: &str, tool: String) {
    // ruleid: jgates.rust.os-command-non-literal-program
    Command::new(program).output().unwrap();
    // ruleid: jgates.rust.os-command-non-literal-program
    Command::new(&tool).arg("--version").output().unwrap();
    // ok: jgates.rust.os-command-non-literal-program
    Command::new("git").arg(program).output().unwrap();
    // ok: jgates.rust.os-command-non-literal-program
    Command::new("ls").output().unwrap();
}
