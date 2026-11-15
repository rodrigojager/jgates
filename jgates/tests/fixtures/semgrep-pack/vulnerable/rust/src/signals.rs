use std::collections::HashMap;

use async_graphql::{Object, Schema};
use axum::extract::ws::{Message, WebSocket};
use axum::extract::Multipart;
use flate2::read::GzDecoder;
use jsonwebtoken::{decode, DecodingKey, Validation};
use ldap3::LdapConn;
use lettre::{SmtpTransport, Transport};
use memcache::Client as CacheClient;
use oauth2::basic::BasicClient;
use oxide_auth::endpoint::OwnerConsent;
use quick_xml::Reader;
use samael::metadata::EntityDescriptor;
use tera::Tera;
use totp_rs::{Algorithm, TOTP};
use wasm_bindgen::prelude::*;
use web_sys::Document;
use webrtc::api::APIBuilder;

// A service that touches every technology of the signal list that Rust can show.
pub struct Services {
    pub cache: Option<CacheClient>,
    pub templates: Option<Tera>,
    pub mailer: Option<SmtpTransport>,
    pub directory: Option<LdapConn>,
    pub counters: HashMap<String, u64>,
}

pub fn describe() -> Vec<&'static str> {
    let _ = (
        std::any::type_name::<Schema<(), (), ()>>(),
        std::any::type_name::<Object>(),
        std::any::type_name::<Message>(),
        std::any::type_name::<WebSocket>(),
        std::any::type_name::<Multipart>(),
        std::any::type_name::<GzDecoder<&[u8]>>(),
        std::any::type_name::<DecodingKey>(),
        std::any::type_name::<Validation>(),
        std::any::type_name::<BasicClient>(),
        std::any::type_name::<OwnerConsent>(),
        std::any::type_name::<Reader<&[u8]>>(),
        std::any::type_name::<EntityDescriptor>(),
        std::any::type_name::<TOTP>(),
        std::any::type_name::<Algorithm>(),
        std::any::type_name::<Document>(),
        std::any::type_name::<APIBuilder>(),
    );
    vec!["graphql", "websocket", "webrtc", "oauth", "jwt", "saml", "totp", "ldap", "xml", "memcache", "mail", "templates", "upload", "archive", "dom"]
}

#[wasm_bindgen]
pub fn greet() -> String {
    let _ = decode::<()>;
    let _ = Transport::send;
    String::from("hello")
}
