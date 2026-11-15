use axum::extract::Json;
use totp_rs::{Algorithm, TOTP};

struct Account {
    email: String,
    role: String,
}

struct Recovery {
    pub secret_question: String,
}

fn password_ok(password: &str) -> bool {
    if password.len() < 6 {
        return false;
    }
    if password.len() > 20 {
        return false;
    }
    true
}

fn composition_rule() {
    let password_rule = fancy_regex::Regex::new(r"^(?=.*[A-Z])(?=.*\d).{8,}$").unwrap();
}

fn verify_login(password: &str, stored_hash: &str) -> bool {
    let folded = password.to_lowercase();
    bcrypt::verify(&folded, stored_hash).unwrap_or(false)
}

async fn register(Json(body): Json<NewAccount>) -> Account {
    Account { email: body.email, role: body.role }
}

fn second_factor(secret: Vec<u8>) -> TOTP {
    TOTP::new(Algorithm::SHA1, 6, 1, 90, secret).unwrap()
}
