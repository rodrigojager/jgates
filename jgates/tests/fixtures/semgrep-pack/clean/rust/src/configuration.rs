use actix_files::Files;
use actix_web::App;

pub fn static_files() {
    let files = Files::new("/static", "./public").index_file("index.html");
    let _app = App::new().service(files);
}
