use axum::extract::{DefaultBodyLimit, Multipart, Query};
use std::fs::File;
use std::path::Path;

pub fn limits() -> DefaultBodyLimit {
    DefaultBodyLimit::max(2 * 1024 * 1024)
}

pub async fn read_body(body: hyper::Body) -> Bytes {
    hyper::body::to_bytes(http_body_util::Limited::new(body, 2 * 1024 * 1024)).await.unwrap()
}

pub async fn upload(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.file_name().unwrap().to_string();
        let data = field.bytes().await.unwrap();
        if infer::get(&data).map(|t| t.mime_type()) != Some("image/png") {
            continue;
        }
        let base = Path::new(&name).file_name().unwrap();
        tokio::fs::write(Path::new("uploads").join(base), data).await.unwrap();
    }
}

pub fn unpack_upload(archive: &mut tar::Archive<File>, dest: &Path) {
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        entry.unpack_in(dest).unwrap();
        let target = dest.join(entry.path().unwrap());
        if !target.starts_with(dest) {
            continue;
        }
    }
}

pub async fn download(Query(params): Query<DownloadParams>) -> impl IntoResponse {
    let headers = [(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename*=UTF-8''{}", urlencoding::encode(&params.name)),
    )];
    (headers, "data")
}

pub struct DownloadParams {
    pub name: String,
}
