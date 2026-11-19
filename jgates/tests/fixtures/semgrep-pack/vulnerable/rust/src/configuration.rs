use actix_files::Files;
use actix_web::App;
use actix_web::{web, HttpResponse};

pub fn create_user(body: web::Json<User>, conn: &mut Connection) -> Result<(), Error> {
    diesel::insert_into(users::table).values(&body.into_inner()).execute(conn)?;
    Ok(())
}

pub fn get_user(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let user = users::table.first::<User>(conn)?;
    Ok(HttpResponse::Ok().json(user))
}

pub fn static_files() {
    let files = Files::new("/static", "./public").show_files_listing();
    let _app = App::new().service(files);
}
