use actix_files::Files;
use actix_web::App;
use actix_web::{web, HttpResponse};

pub fn create_user(body: web::Json<UserInput>, conn: &mut Connection) -> Result<(), Error> {
    let insert = NewUser { name: body.name.clone(), role: "member".into() };
    diesel::insert_into(users::table).values(&insert).execute(conn)?;
    Ok(())
}

pub fn get_user(conn: &mut Connection) -> Result<HttpResponse, Error> {
    let user = users::table.first::<User>(conn)?;
    Ok(HttpResponse::Ok().json(UserResponse { name: user.name }))
}

pub fn static_files() {
    let files = Files::new("/static", "./public").index_file("index.html");
    let _app = App::new().service(files);
}
