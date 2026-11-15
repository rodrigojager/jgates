use actix_files::Files;
use actix_web::App;

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
