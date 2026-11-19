// Fixture of rust-signals.yaml: one match and one non-match per rule. Never compiled or run.

// ruleid: jgates.rust.uses-graphql
use async_graphql::{Context, Object, Schema};

// ruleid: jgates.rust.uses-graphql
use juniper::graphql_object;

// ok: jgates.rust.uses-graphql
use example_notes::graphql;

// ruleid: jgates.rust.uses-websocket
use tokio_tungstenite::connect_async;

// ruleid: jgates.rust.uses-websocket
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};

// ok: jgates.rust.uses-websocket
use example_notes::websocket;

// ruleid: jgates.rust.uses-webrtc
use webrtc::api::APIBuilder;

// ruleid: jgates.rust.uses-webrtc
use str0m::Rtc;

// ok: jgates.rust.uses-webrtc
use example_notes::webrtc;

// ruleid: jgates.rust.uses-oauth-client
use oauth2::basic::BasicClient;

// ruleid: jgates.rust.uses-oauth-client
use openidconnect::core::CoreClient;

// ok: jgates.rust.uses-oauth-client
use example_notes::oauth2;

// ruleid: jgates.rust.uses-oauth-authorization-server
use oxide_auth::endpoint::OwnerConsent;

// ruleid: jgates.rust.uses-oauth-authorization-server
use oxide_auth_axum::OAuthRequest;

// ok: jgates.rust.uses-oauth-authorization-server
use example_notes::oxide_auth;

// ruleid: jgates.rust.uses-jwt
use jsonwebtoken::{decode, DecodingKey, Validation};

// ruleid: jgates.rust.uses-jwt
use jwt_simple::prelude::*;

// ok: jgates.rust.uses-jwt
use example_notes::jsonwebtoken;

// ruleid: jgates.rust.uses-saml
use samael::metadata::EntityDescriptor;

// ruleid: jgates.rust.uses-saml
use saml2::response::Response;

// ok: jgates.rust.uses-saml
use example_notes::samael;

// ruleid: jgates.rust.uses-totp
use totp_rs::{Algorithm, TOTP};

// ruleid: jgates.rust.uses-totp
use libreauth::oath::TOTPBuilder;

// ok: jgates.rust.uses-totp
use libreauth::pass::HashBuilder;

// ok: jgates.rust.uses-totp
use example_notes::totp;

// ruleid: jgates.rust.uses-ldap
use ldap3::{LdapConn, Scope};

// ruleid: jgates.rust.uses-ldap
use ldap3_proto::proto::LdapMsg;

// ok: jgates.rust.uses-ldap
use example_notes::ldap;

// ruleid: jgates.rust.uses-xml
use quick_xml::Reader;

// ruleid: jgates.rust.uses-xml
use roxmltree::Document;

// ok: jgates.rust.uses-xml
use example_notes::xml;

// ruleid: jgates.rust.uses-memcache
use memcache::Client;

// ruleid: jgates.rust.uses-memcache
use async_memcached::AsciiProtocol;

// ok: jgates.rust.uses-memcache
use example_notes::memcache;

// ruleid: jgates.rust.uses-mail
use lettre::{Message as MailMessage, SmtpTransport, Transport};

// ruleid: jgates.rust.uses-mail
use mail_send::SmtpClientBuilder;

// ok: jgates.rust.uses-mail
use example_notes::lettre;

// ruleid: jgates.rust.uses-templates
use tera::{Context as TeraContext, Tera};

// ruleid: jgates.rust.uses-templates
use askama::Template;

// ok: jgates.rust.uses-templates
use example_notes::tera;

// ruleid: jgates.rust.uses-file-upload
use axum::extract::Multipart;

// ruleid: jgates.rust.uses-file-upload
use actix_multipart::Multipart as ActixMultipart;

// ok: jgates.rust.uses-file-upload
use example_notes::multipart;

// ruleid: jgates.rust.uses-archives
use zip::ZipArchive;

// ruleid: jgates.rust.uses-archives
use flate2::read::GzDecoder;

// ok: jgates.rust.uses-archives
use example_notes::zip;

// ruleid: jgates.rust.uses-browser-dom
use web_sys::{Document, Window};

// ruleid: jgates.rust.uses-browser-dom
use wasm_bindgen::prelude::*;

// ok: jgates.rust.uses-browser-dom
use example_notes::web_sys;

// ruleid: jgates.rust.uses-jwt
pub use jsonwebtoken as tokens;

// ruleid: jgates.rust.uses-archives
extern crate tar;

// ok: jgates.rust.uses-graphql
const NOTE_GRAPHQL: &str = "use async_graphql::Schema is only mentioned here";

// ok: jgates.rust.uses-websocket
const NOTE_WS: &str = "tokio_tungstenite"; // use tungstenite::connect is not an import

/// use lettre::SmtpTransport (a doc comment is not an import)
// ok: jgates.rust.uses-mail
fn mentions_only() -> usize {
    let _ = "use quick_xml::Reader;";
    1
}
