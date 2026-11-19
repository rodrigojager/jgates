use axum::body::Bytes;

async fn import_pickle(body: Bytes) {
    // ruleid: jgates.rust.unsafe-deserialization
    let _v: Value = serde_pickle::from_slice(&body, Default::default()).unwrap();
}

async fn import_reader(data: Vec<u8>) {
    // ruleid: jgates.rust.unsafe-deserialization
    let _v: Value = serde_pickle::from_reader(data.as_slice(), Default::default()).unwrap();
}

async fn import_archive(payload: web::Bytes) {
    // ruleid: jgates.rust.unsafe-deserialization
    let _v: Record = unsafe { rkyv::from_bytes_unchecked(&payload) };
}

async fn safe_imports(body: Bytes) {
    // ok: jgates.rust.unsafe-deserialization
    let _a: Record = serde_json::from_slice(&body).unwrap();
    // ok: jgates.rust.unsafe-deserialization
    let _b: Value = serde_pickle::from_slice(include_bytes!("seed.pkl"), Default::default()).unwrap();
    let local: Vec<u8> = Vec::new();
    // ok: jgates.rust.unsafe-deserialization
    let _c: Value = serde_pickle::from_slice(&local, Default::default()).unwrap();
}
