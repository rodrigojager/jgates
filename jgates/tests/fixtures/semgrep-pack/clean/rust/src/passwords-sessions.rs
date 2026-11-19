use axum::extract::Json;
use totp_rs::{Algorithm, TOTP};

struct Account {
    email: String,
    role: String,
}

struct Recovery {
    pub recovery_email: String,
}

fn password_ok(password: &str) -> bool {
    if password.len() < 12 {
        return false;
    }
    if password.len() > 128 {
        return false;
    }
    true
}

fn length_rule() {
    let password_rule = regex::Regex::new(r"^.{12,128}$").unwrap();
}

fn verify_login(password: &str, stored_hash: &str) -> bool {
    bcrypt::verify(password, stored_hash).unwrap_or(false)
}

async fn register(Json(body): Json<NewAccount>) -> Account {
    Account { email: body.email, role: "user".to_string() }
}

fn second_factor(secret: Vec<u8>) -> TOTP {
    TOTP::new(Algorithm::SHA1, 6, 1, 30, secret).unwrap()
}
