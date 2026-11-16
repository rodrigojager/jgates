use axum::extract::{DefaultBodyLimit, Multipart, Query};
use std::path::Path;

async fn upload_axum(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.file_name().unwrap().to_string();
        let data = field.bytes().await.unwrap();
        // ruleid: jgates.rust.upload-client-filename-in-path
        tokio::fs::write(format!("uploads/{}", name), data).await.unwrap();
    }
}

async fn upload_join(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.file_name().unwrap().to_string();
        // ruleid: jgates.rust.upload-client-filename-in-path
        let target = Path::new("uploads").join(&name);
        let data = field.bytes().await.unwrap();
        // ruleid: jgates.rust.upload-client-filename-in-path
        std::fs::write(&target, data).unwrap();
    }
}

async fn upload_actix(mut payload: actix_multipart::Multipart) {
    while let Some(Ok(mut field)) = payload.next().await {
        let name = field.content_disposition().get_filename().unwrap().to_string();
        // ruleid: jgates.rust.upload-client-filename-in-path
        let mut out = File::create(format!("./tmp/{}", name)).unwrap();
        out.flush().unwrap();
    }
}

async fn upload_safe(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.file_name().unwrap().to_string();
        let data = field.bytes().await.unwrap();
        // ok: jgates.rust.upload-client-filename-in-path
        let base = Path::new(&name).file_name().unwrap();
        // ok: jgates.rust.upload-client-filename-in-path
        tokio::fs::write(Path::new("uploads").join(base), &data).await.unwrap();
        // ok: jgates.rust.upload-client-filename-in-path
        tokio::fs::write(format!("uploads/{}", sanitize_filename::sanitize(&name)), &data).await.unwrap();
        // ok: jgates.rust.upload-client-filename-in-path
        tokio::fs::write(format!("uploads/{}.bin", uuid::Uuid::new_v4()), &data).await.unwrap();
    }
}

fn unzip_by_name(archive: &mut zip::ZipArchive<File>, dest: &Path) {
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        // ruleid: jgates.rust.archive-extraction-unchecked
        let outpath = dest.join(file.name());
        let mut out = File::create(&outpath).unwrap();
        std::io::copy(&mut file, &mut out).unwrap();
    }
}

fn untar_by_path(archive: &mut tar::Archive<File>, dest: &Path) {
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        // ruleid: jgates.rust.archive-extraction-unchecked
        let target = dest.join(entry.path().unwrap());
        entry.unpack(&target).unwrap();
    }
}

fn untar_whole(reader: File, dest: &str) {
    let mut archive = tar::Archive::new(reader);
    // ruleid: jgates.rust.archive-extraction-unchecked
    archive.unpack(dest).unwrap();
}

fn unzip_whole(reader: File, dest: &str) {
    let mut archive = zip::ZipArchive::new(reader).unwrap();
    // ruleid: jgates.rust.archive-extraction-unchecked
    archive.extract(dest).unwrap();
}

fn unzip_checked(archive: &mut zip::ZipArchive<File>, dest: &Path) {
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        // ok: jgates.rust.archive-extraction-unchecked
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        let mut out = File::create(&outpath).unwrap();
        std::io::copy(&mut file, &mut out).unwrap();
    }
}

fn untar_checked(archive: &mut tar::Archive<File>, dest: &Path) {
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        // ok: jgates.rust.archive-extraction-unchecked
        let target = dest.join(entry.path().unwrap());
        if !target.starts_with(dest) {
            continue;
        }
        entry.unpack(&target).unwrap();
    }
}

fn untar_capped(reader: File, dest: &str) {
    // ok: jgates.rust.archive-extraction-unchecked
    let mut archive = tar::Archive::new(reader.take(64 * 1024 * 1024));
    archive.unpack(dest).unwrap();
}

fn unzip_whole_size_checked(reader: File, dest: &str) {
    let mut archive = zip::ZipArchive::new(reader).unwrap();
    let mut total = 0;
    for i in 0..archive.len() {
        total += archive.by_index(i).unwrap().size();
    }
    if total < 64 * 1024 * 1024 {
        // ok: jgates.rust.archive-extraction-unchecked
        archive.extract(dest).unwrap();
    }
}

fn routes_unlimited() {
    // ruleid: jgates.rust.request-body-without-size-limit
    let a = DefaultBodyLimit::disable();
    // ruleid: jgates.rust.request-body-without-size-limit
    let b = web::PayloadConfig::new(usize::MAX);
    // ruleid: jgates.rust.request-body-without-size-limit
    let c = web::JsonConfig::default().limit(usize::MAX);
    drop((a, b, c));
}

async fn read_all(body: Body) -> Bytes {
    // ruleid: jgates.rust.request-body-without-size-limit
    axum::body::to_bytes(body, usize::MAX).await.unwrap()
}

async fn read_hyper(body: hyper::Body) -> Bytes {
    // ruleid: jgates.rust.request-body-without-size-limit-by-default
    hyper::body::to_bytes(body).await.unwrap()
}

async fn read_hyper_response(request: hyper::Request<hyper::Body>) -> Bytes {
    // ruleid: jgates.rust.request-body-without-size-limit-by-default
    hyper::body::to_bytes(request.into_body()).await.unwrap()
}

async fn read_hyper_limited(body: hyper::Body) {
    // ok: jgates.rust.request-body-without-size-limit-by-default
    let a = hyper::body::to_bytes(Limited::new(body, 4096)).await;
    // ok: jgates.rust.request-body-without-size-limit-by-default
    let b = hyper::body::to_bytes(http_body_util::Limited::new(body, 8192)).await;
    drop((a, b));
}

fn explicit_limits_are_not_defaults() {
    // ok: jgates.rust.request-body-without-size-limit-by-default
    // ruleid: jgates.rust.request-body-without-size-limit
    let a = DefaultBodyLimit::disable();
    // ok: jgates.rust.request-body-without-size-limit-by-default
    // ruleid: jgates.rust.request-body-without-size-limit
    let b = web::PayloadConfig::new(usize::MAX);
    drop((a, b));
}

async fn routes_limited(body: Body) {
    // ok: jgates.rust.request-body-without-size-limit
    let a = DefaultBodyLimit::max(2 * 1024 * 1024);
    // ok: jgates.rust.request-body-without-size-limit
    let b = web::PayloadConfig::new(1_048_576);
    // ok: jgates.rust.request-body-without-size-limit
    let c = axum::body::to_bytes(body, 1_048_576).await.unwrap();
    // ok: jgates.rust.request-body-without-size-limit
    let d = hyper::body::to_bytes(Limited::new(body, 4096)).await;
    drop((a, b, c, d));
}

async fn check_type(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        // ruleid: jgates.rust.upload-content-type-trusted
        if field.content_type() == Some("image/png") {
            save(field).await;
        }
    }
}

async fn check_allowed(mut payload: actix_multipart::Multipart) {
    while let Some(Ok(field)) = payload.next().await {
        // ruleid: jgates.rust.upload-content-type-trusted
        if field.content_type().essence_str() != "image/jpeg" {
            continue;
        }
    }
}

async fn check_sniffed(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let declared = field.content_type().map(|s| s.to_string());
        let data = field.bytes().await.unwrap();
        // ok: jgates.rust.upload-content-type-trusted
        if infer::get(&data).map(|t| t.mime_type()) == Some("image/png") {
            log_declared(declared);
        }
    }
}

async fn record_type(mut multipart: Multipart) {
    while let Some(field) = multipart.next_field().await.unwrap() {
        // ok: jgates.rust.upload-content-type-trusted
        let name = field.name().unwrap_or("file");
        // ok: jgates.rust.upload-content-type-trusted
        log_declared(field.content_type().map(|s| s.to_string()));
        drop(name);
    }
}

async fn download(Query(params): Query<FileParams>) -> impl IntoResponse {
    // ruleid: jgates.rust.content-disposition-from-request
    let headers = [(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", params.name))];
    (headers, "data")
}

async fn download_builder(Query(params): Query<FileParams>) -> Response {
    Response::builder()
        // ruleid: jgates.rust.content-disposition-from-request
        .header("Content-Disposition", format!("attachment; filename={}", params.name))
        .body(Body::empty())
        .unwrap()
}

async fn download_safe(Query(params): Query<FileParams>) -> impl IntoResponse {
    // ok: jgates.rust.content-disposition-from-request
    let a = [(header::CONTENT_DISPOSITION, "attachment; filename=\"report.pdf\"".to_string())];
    // ok: jgates.rust.content-disposition-from-request
    let b = [(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", sanitize_filename::sanitize(&params.name)))];
    // ok: jgates.rust.content-disposition-from-request
    let c = [(header::CONTENT_DISPOSITION, format!("attachment; filename*=UTF-8''{}", urlencoding::encode(&params.name)))];
    drop((a, b));
    c
}
