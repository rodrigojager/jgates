use std::collections::HashMap;

// Notes: a library such as async_graphql, tera or lettre is only named in this comment.
const NOTE: &str = "use quick_xml::Reader; use jsonwebtoken::decode; only named in a string";

pub struct Counters {
    pub values: HashMap<String, u64>,
}

impl Counters {
    pub fn new() -> Self {
        Counters { values: HashMap::new() }
    }

    pub fn bump(&mut self, name: &str) -> u64 {
        let entry = self.values.entry(name.to_string()).or_insert(0);
        *entry += 1;
        *entry
    }

    pub fn note() -> &'static str {
        NOTE
    }
}
