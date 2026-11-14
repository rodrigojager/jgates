use axum::{extract::Query, response::Html};
use maud::PreEscaped;

async fn greet(Query(q): Query<Hello>) -> Html<String> {
    // ruleid: jgates.rust.xss
    Html(format!("<h1>Hello {}</h1>", q.name))
}

async fn page(body: web::Query<Hello>) -> HttpResponse {
    let name = body.name.clone();
    // ruleid: jgates.rust.xss
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(name)
}

async fn safe_pages(Query(q): Query<Hello>) -> Html<String> {
    // ok: jgates.rust.xss
    let _ = Html("<h1>Welcome</h1>".to_string());
    // ok: jgates.rust.xss
    let _ = HttpResponse::Ok().content_type("text/plain").body(q.name.clone());
    // ok: jgates.rust.xss
    Html(format!("<h1>Hello {}</h1>", html_escape::encode_text(&q.name)))
}

fn markup(comment: &str, name: String) {
    // ruleid: jgates.rust.pre-escaped-non-literal
    let _a = PreEscaped(comment);
    // ruleid: jgates.rust.pre-escaped-non-literal
    let _b = PreEscaped(format!("<b>{}</b>", name));
    // ok: jgates.rust.pre-escaped-non-literal
    let _c = PreEscaped("&nbsp;");
    // ok: jgates.rust.pre-escaped-non-literal
    let _d = maud::PreEscaped("<hr>");
    // ok: jgates.rust.pre-escaped-non-literal
    let _e = PreEscaped(html_escape::encode_text(comment));
}
