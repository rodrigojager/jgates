use axum::extract::Query;
use regex::{Regex, RegexBuilder};

async fn search(Query(q): Query<Search>) {
    // ruleid: jgates.rust.regex-from-request
    let _a = Regex::new(&q.term).unwrap();
    // ruleid: jgates.rust.regex-from-request
    let _b = Regex::new(&format!("^{}$", q.term)).unwrap();
    // ok: jgates.rust.regex-from-request
    let _c = Regex::new("^[a-z]+$").unwrap();
    // ok: jgates.rust.regex-from-request
    let _d = Regex::new(&regex::escape(&q.term)).unwrap();
}

async fn export(Query(q): Query<Search>) {
    let mut writer = csv::Writer::from_writer(vec![]);
    // ruleid: jgates.rust.csv-formula-injection
    writer.write_record(&[&q.term]).unwrap();
    // ruleid: jgates.rust.csv-formula-injection
    writer.write_field(&q.term).unwrap();
    // ok: jgates.rust.csv-formula-injection
    writer.write_record(&[format!("'{}", q.term)]).unwrap();
    // ok: jgates.rust.csv-formula-injection
    writer.write_field(format!("'{}", q.term)).unwrap();
    let cache = memcache::Client::connect("memcache://localhost:11211").unwrap();
    // ruleid: jgates.rust.memcache-key-from-request
    cache.set(&q.term, "value", 60).unwrap();
    // ruleid: jgates.rust.memcache-key-from-request
    cache.delete(&q.term).unwrap();
    // ok: jgates.rust.memcache-key-from-request
    cache.set(&blake3::hash(q.term.as_bytes()).to_hex().to_string(), "value", 60).unwrap();
    // ok: jgates.rust.memcache-key-from-request
    cache.delete(&blake3::hash(q.term.as_bytes()).to_hex().to_string()).unwrap();
    // ruleid: jgates.rust.url-parameter-unencoded
    let url = format!("https://example.org/search?q={}", q.term);
    // ruleid: jgates.rust.url-parameter-unencoded
    let path = format!("https://example.org/users/{}", q.term);
    // ok: jgates.rust.url-parameter-unencoded
    let safe_url = format!("https://example.org/search?q={}", urlencoding::encode(&q.term));
    // ok: jgates.rust.url-parameter-unencoded
    let safe_path = format!("https://example.org/users/{}", urlencoding::encode(&q.term));
    // ruleid: jgates.rust.json-built-by-concatenation
    let json = format!("{{\"name\":\"{}\"}}", q.term);
    // ruleid: jgates.rust.json-built-by-concatenation
    let other = format!("{{\"query\":\"{}\",\"active\":true}}", q.term);
    // ok: jgates.rust.json-built-by-concatenation
    let safe_json = serde_json::json!({"name": q.term}).to_string();
    // ok: jgates.rust.json-built-by-concatenation
    let safe_other = format!("{{\"query\":{}}}", serde_json::to_string(&q.term).unwrap());
    // ok: jgates.rust.json-built-by-concatenation
    let numeric = format!("{{\"page\":{},\"data\":{}}}", q.page, data);
    // ok: jgates.rust.json-built-by-concatenation
    let count = format!("{{\"count\":{}}}", q.count);
}

fn decode(input: &str) {
    // ruleid: jgates.rust.double-decoding
    let url = urlencoding::decode(&urlencoding::decode(input).unwrap()).unwrap();
    // ruleid: jgates.rust.double-decoding
    let html = html_escape::decode_html_entities(&html_escape::decode_html_entities(input));
    // ok: jgates.rust.double-decoding
    let once = urlencoding::decode(input).unwrap();
    // ok: jgates.rust.double-decoding
    let once_html = html_escape::decode_html_entities(input);
}

fn explicit_markdown(input: &str) {
    let mut options = comrak::Options::default();
    // ruleid: jgates.rust.markdown-raw-html-enabled
    options.render.unsafe_ = true;
    let _html = comrak::markdown_to_html(input, &options);
    // ruleid: jgates.rust.markdown-raw-html-enabled
    options.render.r#unsafe = true;
    // ok: jgates.rust.markdown-raw-html-enabled
    options.render.unsafe_ = false;
    // ok: jgates.rust.markdown-raw-html-enabled
    options.render.r#unsafe = false;
}

fn default_markdown(input: &str) {
    let mut output = String::new();
    // ruleid: jgates.rust.markdown-raw-html-enabled-by-default
    pulldown_cmark::html::push_html(&mut output, pulldown_cmark::Parser::new(input));
}

fn default_markdown_ext(input: &str) {
    let mut output = String::new();
    let parser = pulldown_cmark::Parser::new_ext(input, pulldown_cmark::Options::empty());
    // ruleid: jgates.rust.markdown-raw-html-enabled-by-default
    pulldown_cmark::html::push_html(&mut output, parser);
}

fn sanitized_markdown(input: &str) {
    let mut output = String::new();
    // ok: jgates.rust.markdown-raw-html-enabled-by-default
    pulldown_cmark::html::push_html(&mut output, pulldown_cmark::Parser::new(input));
    let safe = ammonia::clean(&output);
}

fn sanitized_markdown_ext(input: &str) {
    let mut output = String::new();
    let parser = pulldown_cmark::Parser::new_ext(input, pulldown_cmark::Options::empty());
    // ok: jgates.rust.markdown-raw-html-enabled-by-default
    pulldown_cmark::html::push_html(&mut output, parser);
    let safe = ammonia::clean(&output);
}

async fn builder(body: web::Query<Search>) {
    let term = body.term.clone();
    // ruleid: jgates.rust.regex-from-request
    let _e = RegexBuilder::new(&term).case_insensitive(true).build();
    // ok: jgates.rust.regex-from-request
    let _f = RegexBuilder::new(&regex::escape(&term)).case_insensitive(true).build();
    // ok: jgates.rust.regex-from-request
    let _g = RegexBuilder::new("^abc$").build();
}
