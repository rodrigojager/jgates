use axum::extract::{DefaultBodyLimit, Multipart, Query};
use std::fs::File;
use std::path::Path;

pub fn limits() -> DefaultBodyLimit {
    DefaultBodyLimit::disable()
}

pub async fn read_body(body: hyper::Body) -> Bytes {
    hyper::body::to_bytes(body).await.unwrap()
}

pub async fn upload(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.file_name().unwrap().to_string();
        if field.content_type() != Some("image/png") {
            continue;
        }
        let data = field.bytes().await.unwrap();
        tokio::fs::write(format!("uploads/{}", name), data).await.unwrap();
    }
}

pub fn unpack_upload(reader: File, dest: &str) {
    let mut archive = tar::Archive::new(reader);
    archive.unpack(dest).unwrap();
}

pub async fn download(Query(params): Query<DownloadParams>) -> impl IntoResponse {
    let headers = [(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", params.name))];
    (headers, "data")
}

pub struct DownloadParams {
    pub name: String,
}

pub fn unused(_p: &Path) {}
