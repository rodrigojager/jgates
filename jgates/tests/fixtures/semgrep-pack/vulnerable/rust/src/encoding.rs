use axum::extract::Query;
use regex::Regex;

async fn find(Query(q): Query<Search>) -> usize {
    let re = Regex::new(&format!("^{}$", q.term)).unwrap();
    re.find_iter("sample text").count()
}

async fn export(Query(q): Query<Search>) {
    let mut writer = csv::Writer::from_writer(vec![]);
    writer.write_record(&[&q.term]).unwrap();
    let cache = memcache::Client::connect("memcache://localhost:11211").unwrap();
    cache.set(&q.term, "value", 60).unwrap();
    let url = format!("https://example.org/search?q={}", q.term);
    let json = format!("{{\"name\":\"{}\"}}", q.term);
}

fn render(input: &str) {
    let decoded = urlencoding::decode(&urlencoding::decode(input).unwrap()).unwrap();
    let mut options = comrak::Options::default();
    options.render.unsafe_ = true;
    let html = comrak::markdown_to_html(input, &options);
    let mut output = String::new();
    pulldown_cmark::html::push_html(&mut output, pulldown_cmark::Parser::new(input));
}
