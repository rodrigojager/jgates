use actix_files::Files;
use actix_web::App;
use actix_web::{web, HttpResponse};

fn create_user(body: web::Json<User>, conn: &mut Connection) -> Result<(), Error> {
    // ruleid: jgates.rust.mass-assignment
    diesel::insert_into(users::table).values(&body.into_inner()).execute(conn)?;
    Ok(())
}

fn create_account(body: actix_web::web::Json<Account>, conn: &mut Connection) -> Result<(), Error> {
    // ruleid: jgates.rust.mass-assignment
    insert_into(accounts::table).values(&body.into_inner()).execute(conn)?;
    Ok(())
}

fn create_user_allowlist(body: web::Json<UserInput>, conn: &mut Connection) -> Result<(), Error> {
    let insert = NewUser { name: body.name.clone(), role: "member".into() };
    // ok: jgates.rust.mass-assignment
    diesel::insert_into(users::table).values(&insert).execute(conn)?;
    Ok(())
}

fn create_account_allowlist(body: actix_web::web::Json<AccountInput>, conn: &mut Connection) -> Result<(), Error> {
    // ok: jgates.rust.mass-assignment
    insert_into(accounts::table).values((accounts::name.eq(&body.name),)).execute(conn)?;
    Ok(())
}

fn get_user(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let user = users::table.first::<User>(conn)?;
    // ruleid: jgates.rust.serializer-exposes-all-fields
    Ok(HttpResponse::Ok().json(user))
}

fn get_accounts(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let accounts = accounts::table.load::<Account>(conn)?;
    // ruleid: jgates.rust.serializer-exposes-all-fields
    Ok(HttpResponse::Ok().json(accounts))
}

fn get_user_dto(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let user = users::table.first::<User>(conn)?;
    // ok: jgates.rust.serializer-exposes-all-fields
    Ok(HttpResponse::Ok().json(UserResponse { name: user.name }))
}

fn get_accounts_dto(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let accounts = accounts::table.load::<Account>(conn)?;
    let response: Vec<AccountResponse> = accounts.into_iter().map(|a| AccountResponse { name: a.name }).collect();
    // ok: jgates.rust.serializer-exposes-all-fields
    Ok(HttpResponse::Ok().json(response))
}

fn listing() {
    // ruleid: jgates.rust.directory-listing-enabled
    let _a = Files::new("/static", "./static").show_files_listing();
    // ruleid: jgates.rust.directory-listing-enabled
    let _b = actix_files::Files::new("/files", "./files").index_file("a.html").show_files_listing();
}

fn safe() {
    // ok: jgates.rust.directory-listing-enabled
    let _c = Files::new("/static", "./static").index_file("index.html");
    // ok: jgates.rust.directory-listing-enabled
    let _d = actix_files::Files::new("/files", "./files").prefer_utf8(true);
    // ok: jgates.rust.directory-listing-enabled
    let _e = other.show_files_listing();
}
