use axum::extract::Query;
use std::process::Command;

#[derive(serde::Deserialize)]
struct Lookup {
    uid: String,
    id: String,
    body: String,
    email: String,
}

async fn find_person(ldap: &mut ldap3::Ldap, Query(params): Query<Lookup>) {
    let filter = format!("(uid={})", params.uid);
    ldap.search("ou=people,dc=example,dc=com", ldap3::Scope::Subtree, &filter, vec!["cn"]).await;
}

async fn find_item(pkg: &sxd_document::Package, Query(params): Query<Lookup>) {
    let expr = format!("//item[@id='{}']", params.id);
    let doc = pkg.as_document();
    sxd_xpath::evaluate_xpath(&doc, &expr).unwrap();
}

async fn render_page(Query(params): Query<Lookup>) -> String {
    tera::Tera::one_off(&params.body, &tera::Context::new(), true).unwrap()
}

async fn notify(Query(params): Query<Lookup>) -> String {
    let raw = format!("To: {}\r\nSubject: Hello\r\n\r\nBody", params.email);
    raw
}

fn build_pdf(source: &str) {
    Command::new("pdflatex").arg("-shell-escape").arg(source).output().unwrap();
}
