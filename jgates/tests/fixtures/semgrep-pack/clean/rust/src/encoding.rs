use axum::extract::Query;
use regex::Regex;

async fn find(Query(q): Query<Search>) -> usize {
    let re = Regex::new(&format!("^{}$", regex::escape(&q.term))).unwrap();
    re.find_iter("sample text").count()
}

async fn export(Query(q): Query<Search>) {
    let mut writer = csv::Writer::from_writer(vec![]);
    writer.write_record(&[format!("'{}", q.term)]).unwrap();
    let cache = memcache::Client::connect("memcache://localhost:11211").unwrap();
    cache.set(&blake3::hash(q.term.as_bytes()).to_hex().to_string(), "value", 60).unwrap();
    let url = format!("https://example.org/search?q={}", urlencoding::encode(&q.term));
    let json = serde_json::json!({"name": q.term}).to_string();
}

fn render(input: &str) {
    let decoded = urlencoding::decode(input).unwrap();
    let mut options = comrak::Options::default();
    options.render.unsafe_ = false;
    let html = comrak::markdown_to_html(input, &options);
    let mut output = String::new();
    pulldown_cmark::html::push_html(&mut output, pulldown_cmark::Parser::new(input));
    let safe = ammonia::clean(&output);
}
