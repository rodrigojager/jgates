use axum::extract::Query;
use std::process::Command;

async fn find_person(ldap: &mut ldap3::Ldap, Query(params): Query<Person>) {
    let filter = format!("(uid={})", params.uid);
    // ruleid: jgates.rust.ldap-injection
    ldap.search("ou=people,dc=example,dc=com", ldap3::Scope::Subtree, &filter, vec!["cn"]).await;
}

async fn find_group(ldap: &mut ldap3::Ldap, params: web::Query<Group>) {
    let base = format!("ou={},dc=example,dc=com", params.unit);
    // ruleid: jgates.rust.ldap-injection
    ldap.search(&base, ldap3::Scope::OneLevel, "(objectClass=group)", vec!["cn"]).await;
}

async fn find_safe(ldap: &mut ldap3::Ldap, Query(params): Query<Person>) {
    let safe = ldap3::ldap_escape(&params.uid);
    let filter = format!("(uid={})", safe);
    // ok: jgates.rust.ldap-injection
    ldap.search("ou=people,dc=example,dc=com", ldap3::Scope::Subtree, &filter, vec!["cn"]).await;
    // ok: jgates.rust.ldap-injection
    ldap.search("ou=people,dc=example,dc=com", ldap3::Scope::Subtree, "(objectClass=person)", vec!["cn"]).await;
}

async fn xpath_lookup(pkg: &sxd_document::Package, Query(params): Query<Item>) {
    let expr = format!("//item[@id='{}']", params.id);
    let doc = pkg.as_document();
    // ruleid: jgates.rust.xpath-injection
    sxd_xpath::evaluate_xpath(&doc, &expr).unwrap();
}

async fn xpath_compile(Query(params): Query<Item>) {
    let text = format!("//user[name='{}']", params.name);
    // ruleid: jgates.rust.xpath-injection
    let _x = sxd_xpath::Factory::new().build(&text).unwrap();
}

async fn xpath_safe(pkg: &sxd_document::Package, Query(params): Query<Item>) {
    let doc = pkg.as_document();
    let mut context = sxd_xpath::Context::new();
    context.set_variable("id", params.id.as_str());
    // ok: jgates.rust.xpath-injection
    sxd_xpath::Factory::new().build("//item[@id=$id]").unwrap();
    // ok: jgates.rust.xpath-injection
    sxd_xpath::evaluate_xpath(&doc, "//item[@id='7']").unwrap();
    let quoted = escape_xpath_literal(&params.id);
    // ok: jgates.rust.xpath-injection
    sxd_xpath::evaluate_xpath(&doc, &format!("//item[@id={}]", quoted)).unwrap();
}

async fn render_page(tera: &mut tera::Tera, Query(params): Query<Page>) -> String {
    // ruleid: jgates.rust.template-from-request
    tera::Tera::one_off(&params.body, &tera::Context::new(), true).unwrap()
}

async fn render_custom(env: &minijinja::Environment<'_>, hb: &handlebars::Handlebars<'_>, Query(params): Query<Page>) {
    let src = format!("<h1>{}</h1>", params.title);
    // ruleid: jgates.rust.template-from-request
    env.render_str(&src, &ctx).unwrap();
    // ruleid: jgates.rust.template-from-request
    hb.render_template(&params.body, &()).unwrap();
}

async fn render_safe(tera: &tera::Tera, hb: &handlebars::Handlebars<'_>, Query(params): Query<Page>) -> String {
    let mut ctx = tera::Context::new();
    ctx.insert("title", &params.title);
    // ok: jgates.rust.template-from-request
    let page = tera.render("page.html", &ctx).unwrap();
    // ok: jgates.rust.template-from-request
    let _ = hb.render_template("<h1>{{title}}</h1>", &ctx);
    // ok: jgates.rust.template-from-request
    let _ = tera::Tera::one_off("<p>{{ title }}</p>", &ctx, true);
    page
}

async fn send_contact(Query(params): Query<Contact>) -> String {
    // ruleid: jgates.rust.mail-header-injection
    let raw = format!("To: {}\r\nSubject: Hello\r\n\r\nBody", params.email);
    raw
}

async fn send_subject(Query(params): Query<Contact>) -> String {
    // ruleid: jgates.rust.mail-header-injection
    let message = format!("Subject: {}\r\nTo: ops@example.com\r\n\r\nBody", params.subject);
    message
}

async fn send_safe(Query(params): Query<Contact>) -> String {
    let clean = strip_crlf(&params.email);
    // ok: jgates.rust.mail-header-injection
    let raw = format!("To: {}\r\nSubject: Hello\r\n\r\nBody", clean);
    // ok: jgates.rust.mail-header-injection
    let other = format!("Welcome {}\r\n", params.body);
    // ok: jgates.rust.mail-header-injection
    let built = lettre::Message::builder().to(clean.parse().unwrap()).subject("Hello").body(String::from("Body"));
    raw + &other
}

fn build_pdf(source: &str) {
    // ruleid: jgates.rust.latex-shell-escape
    Command::new("pdflatex").arg("-shell-escape").arg(source).output().unwrap();
    // ruleid: jgates.rust.latex-shell-escape
    Command::new("xelatex").args(["-interaction=nonstopmode", "--enable-write18", source]).output().unwrap();
    // ok: jgates.rust.latex-shell-escape
    Command::new("pdflatex").arg("-no-shell-escape").arg(source).output().unwrap();
    // ok: jgates.rust.latex-shell-escape
    Command::new("pdflatex").args(["-interaction=nonstopmode", source]).output().unwrap();
    // ok: jgates.rust.latex-shell-escape
    Command::new("git").arg("-shell-escape").output().unwrap();
}
