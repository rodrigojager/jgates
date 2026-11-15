use actix_files::Files;
use actix_web::App;

pub fn static_files() {
    let files = Files::new("/static", "./public").show_files_listing();
    let _app = App::new().service(files);
}
