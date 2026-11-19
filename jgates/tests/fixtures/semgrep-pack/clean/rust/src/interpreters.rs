use axum::extract::Query;
use std::process::Command;

#[derive(serde::Deserialize)]
struct Lookup {
    uid: String,
    id: String,
    title: String,
    email: String,
}

async fn find_person(ldap: &mut ldap3::Ldap, Query(params): Query<Lookup>) {
    let safe = ldap3::ldap_escape(&params.uid);
    let filter = format!("(uid={})", safe);
    ldap.search("ou=people,dc=example,dc=com", ldap3::Scope::Subtree, &filter, vec!["cn"]).await;
}

async fn find_item(pkg: &sxd_document::Package, Query(params): Query<Lookup>) {
    let doc = pkg.as_document();
    let mut context = sxd_xpath::Context::new();
    context.set_variable("id", params.id.as_str());
    sxd_xpath::Factory::new().build("//item[@id=$id]").unwrap();
    sxd_xpath::evaluate_xpath(&doc, "//item[@id='7']").unwrap();
}

async fn render_page(tera: &tera::Tera, Query(params): Query<Lookup>) -> String {
    let mut ctx = tera::Context::new();
    ctx.insert("title", &params.title);
    tera.render("page.html", &ctx).unwrap()
}

async fn notify(Query(params): Query<Lookup>) -> String {
    let clean = strip_crlf(&params.email);
    let raw = format!("To: {}\r\nSubject: Hello\r\n\r\nBody", clean);
    raw
}

fn build_pdf(source: &str) {
    Command::new("pdflatex").arg("-no-shell-escape").arg(source).output().unwrap();
}
