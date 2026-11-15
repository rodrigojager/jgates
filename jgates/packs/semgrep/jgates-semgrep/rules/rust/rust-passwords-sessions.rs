use axum::extract::{Form, Json, Query};
use totp_rs::{Algorithm, TOTP};
use validator::Validate;

fn check_length(password: &str, new_password: &str) -> bool {
    // ruleid: jgates.rust.password-min-length-below-8
    if password.len() < 6 {
        return false;
    }
    // ruleid: jgates.rust.password-min-length-below-8
    if new_password.chars().count() <= 4 {
        return false;
    }
    // ok: jgates.rust.password-min-length-below-8
    if password.len() < 8 {
        return false;
    }
    // ok: jgates.rust.password-min-length-below-8
    if new_password.chars().count() < 12 {
        return false;
    }
    // ok: jgates.rust.password-min-length-below-8
    if username.len() < 3 {
        return false;
    }
    true
}

#[derive(Validate)]
struct Signup {
    // ruleid: jgates.rust.password-min-length-below-8
    #[validate(length(min = 4))]
    password: String,
    // ok: jgates.rust.password-min-length-below-8
    #[validate(length(min = 3))]
    username: String,
}

#[derive(Validate)]
struct SafeSignup {
    // ok: jgates.rust.password-min-length-below-8
    #[validate(length(min = 12))]
    password: String,
}

fn check_max(password: &str, passphrase: &str) -> bool {
    // ruleid: jgates.rust.password-max-length-below-64
    if password.len() > 20 {
        return false;
    }
    // ruleid: jgates.rust.password-max-length-below-64
    if passphrase.chars().count() > 32 {
        return false;
    }
    // ok: jgates.rust.password-max-length-below-64
    if password.len() > 128 {
        return false;
    }
    // ok: jgates.rust.password-max-length-below-64
    if username.len() > 20 {
        return false;
    }
    true
}

#[derive(Validate)]
struct Rotate {
    // ruleid: jgates.rust.password-max-length-below-64
    #[validate(length(min = 12, max = 16))]
    new_password: String,
    // ok: jgates.rust.password-max-length-below-64
    #[validate(length(min = 12, max = 128))]
    current_password: String,
    // ok: jgates.rust.password-max-length-below-64
    #[validate(length(max = 16))]
    nickname: String,
}

fn composition() {
    // ruleid: jgates.rust.password-composition-rule
    let password_policy = fancy_regex::Regex::new(r"^(?=.*[A-Z])(?=.*\d).{8,}$").unwrap();
    // ruleid: jgates.rust.password-composition-rule
    let pwd_rule = Regex::new("^(?=.*[a-z])(?=.*[0-9])(?=.*[!@#]).+$").unwrap();
    // ok: jgates.rust.password-composition-rule
    let handle_rule = fancy_regex::Regex::new(r"^(?=.*[A-Z]).+$").unwrap();
    // ok: jgates.rust.password-composition-rule
    let password_shape = Regex::new(r"^.{12,128}$").unwrap();
}

async fn login(password: String) -> bool {
    let folded = password.to_lowercase();
    // ruleid: jgates.rust.password-transformed-before-verify
    let ok_a = bcrypt::verify(&folded, &stored_hash).unwrap_or(false);
    let cut = &password[..16];
    // ruleid: jgates.rust.password-transformed-before-verify
    let hashed = bcrypt::hash(cut, 12).unwrap();
    // ok: jgates.rust.password-transformed-before-verify
    let ok_b = bcrypt::verify(&password, &stored_hash).unwrap_or(false);
    let name = username.to_lowercase();
    // ok: jgates.rust.password-transformed-before-verify
    let ok_c = bcrypt::verify(&name, &stored_hash).unwrap_or(false);
    ok_a && ok_b && ok_c
}

async fn argon_login(pwd_input: String) {
    let argon2 = Argon2::default();
    let upper = pwd_input.to_uppercase();
    // ruleid: jgates.rust.password-transformed-before-verify
    let _h = argon2.hash_password(upper.as_bytes(), &salt);
    // ok: jgates.rust.password-transformed-before-verify
    let _v = argon2.hash_password(pwd_input.as_bytes(), &salt);
}

struct Account {
    role: String,
    is_admin: bool,
}

async fn register(Json(body): Json<NewAccount>) {
    // ruleid: jgates.rust.client-controlled-privilege
    let a = Account { role: body.role, is_admin: false };
    let mut b = Account { role: "user".to_string(), is_admin: false };
    // ruleid: jgates.rust.client-controlled-privilege
    b.is_admin = body.is_admin;
    // ok: jgates.rust.client-controlled-privilege
    let c = Account { role: "user".to_string(), is_admin: false };
    // ok: jgates.rust.client-controlled-privilege
    b.role = "member".to_string();
}

async fn update(Form(form): Form<Profile>) {
    // ruleid: jgates.rust.client-controlled-privilege
    let d = Account { role: form.role.clone(), is_admin: false };
    // ok: jgates.rust.client-controlled-privilege
    let e = Account { role: String::from("member"), is_admin: false };
}

fn make_totp() {
    // ruleid: jgates.rust.totp-window-too-wide
    let _a = TOTP::new(Algorithm::SHA1, 6, 1, 60, secret.clone());
    // ruleid: jgates.rust.totp-window-too-wide
    let _b = TOTP::new(Algorithm::SHA1, 6, 5, 30, secret.clone());
    // ok: jgates.rust.totp-window-too-wide
    let _c = TOTP::new(Algorithm::SHA1, 6, 1, 30, secret.clone());
    // ok: jgates.rust.totp-window-too-wide
    let _d = TOTP::new(Algorithm::SHA256, 8, 0, 30, secret.clone());
}

fn read_form(form: &HashMap<String, String>) {
    // ruleid: jgates.rust.secret-question-present
    let _q = form.get("secret_question");
    // ok: jgates.rust.secret-question-present
    let _r = form.get("recovery_email");
}

struct Profile2 {
    // ruleid: jgates.rust.secret-question-present
    pub security_answer: String,
    // ok: jgates.rust.secret-question-present
    pub recovery_email: String,
}

struct Contact {
    // ok: jgates.rust.secret-question-present
    phone: String,
}
