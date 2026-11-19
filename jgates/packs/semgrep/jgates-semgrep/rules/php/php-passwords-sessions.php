<?php

use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;
use OTPHP\TOTP;
use RobThree\Auth\TwoFactorAuth;
use Symfony\Component\Validator\Constraints\Length;
use Symfony\Component\Validator\Constraints\Regex;

// ---- password-min-length-below-8 ----
function min_length_cases($request, $builder, $password)
{
    $rules = [
        // ruleid: jgates.php.password-min-length-below-8
        'password' => 'required|min:6',
        // ruleid: jgates.php.password-min-length-below-8
        'new_password' => ['required', 'min:4'],
        // ok: jgates.php.password-min-length-below-8
        'password_ok' => 'required|min:8',
        // ok: jgates.php.password-min-length-below-8
        'current_password' => 'required|min:1',
        // ok: jgates.php.password-min-length-below-8
        'name' => 'required|min:2',
    ];
    // ruleid: jgates.php.password-min-length-below-8
    $rule = Password::min(6);
    // ruleid: jgates.php.password-min-length-below-8
    $builder->add('password', PasswordType::class, ['constraints' => [new Length(['min' => 6])]]);
    // ruleid: jgates.php.password-min-length-below-8
    if (strlen($password) < 6) {
        return false;
    }
    // ok: jgates.php.password-min-length-below-8
    $strong = Password::min(12);
    // ok: jgates.php.password-min-length-below-8
    $builder->add('password', PasswordType::class, ['constraints' => [new Length(['min' => 8])]]);
    // ok: jgates.php.password-min-length-below-8
    $builder->add('nickname', TextType::class, ['constraints' => [new Length(['min' => 2])]]);
    // ok: jgates.php.password-min-length-below-8
    if (strlen($password) < 8) {
        return false;
    }
    return true;
}

// ---- password-max-length-below-64 ----
function max_length_cases($request, $builder, $password)
{
    $rules = [
        // ruleid: jgates.php.password-max-length-below-64
        'password' => 'required|string|max:32',
        // ruleid: jgates.php.password-max-length-below-64
        'new_password' => ['required', 'max:20'],
        // ok: jgates.php.password-max-length-below-64
        'password_ok' => 'required|string|max:128',
        // ok: jgates.php.password-max-length-below-64
        'title' => 'required|max:30',
    ];
    // ruleid: jgates.php.password-max-length-below-64
    $builder->add('password', PasswordType::class, ['constraints' => [new Length(['max' => 30])]]);
    // ruleid: jgates.php.password-max-length-below-64
    if (strlen($password) > 40) {
        return false;
    }
    // ok: jgates.php.password-max-length-below-64
    $builder->add('password', PasswordType::class, ['constraints' => [new Length(['max' => 4096])]]);
    // ok: jgates.php.password-max-length-below-64
    $builder->add('nickname', TextType::class, ['constraints' => [new Length(['max' => 20])]]);
    // ok: jgates.php.password-max-length-below-64
    if (strlen($password) > 1024) {
        return false;
    }
    // ok: jgates.php.password-max-length-below-64
    $rule = Password::min(8);
    return true;
}

// ---- password-composition-rule ----
function composition_cases($request, $builder, $password)
{
    // ruleid: jgates.php.password-composition-rule
    $a = Password::min(8)->mixedCase()->numbers();
    // ruleid: jgates.php.password-composition-rule
    $b = Password::min(10)->letters()->symbols();
    $rules = [
        // ruleid: jgates.php.password-composition-rule
        'password' => 'required|regex:/^(?=.*[A-Z])(?=.*[0-9]).+$/',
    ];
    // ruleid: jgates.php.password-composition-rule
    $builder->add('password', PasswordType::class, ['constraints' => [new Regex('/^(?=.*\d)(?=.*[a-z]).+$/')]]);
    // ruleid: jgates.php.password-composition-rule
    if (preg_match('/[A-Z]/', $password)) {
        return true;
    }
    // ok: jgates.php.password-composition-rule
    $c = Password::min(12)->uncompromised();
    // ok: jgates.php.password-composition-rule
    $d = Password::min(8);
    // ok: jgates.php.password-composition-rule
    $builder->add('username', TextType::class, ['constraints' => [new Regex('/^(?=.*[a-z]).+$/')]]);
    // ok: jgates.php.password-composition-rule
    if (preg_match('/^\S+$/', $password)) {
        return true;
    }
    return false;
}

// ---- password-transformed-before-verify ----
function transform_cases($request, $password, $hash, $email)
{
    // ruleid: jgates.php.password-transformed-before-verify
    $stored = password_hash(strtolower($password), PASSWORD_DEFAULT);
    // ruleid: jgates.php.password-transformed-before-verify
    $good = password_verify(substr($password, 0, 16), $hash);
    // ruleid: jgates.php.password-transformed-before-verify
    $hashed = Hash::make(mb_strtoupper($password));
    // ruleid: jgates.php.password-transformed-before-verify
    $password = strtolower($password);
    // ok: jgates.php.password-transformed-before-verify
    $stored2 = password_hash($password, PASSWORD_DEFAULT);
    // ok: jgates.php.password-transformed-before-verify
    $good2 = password_verify($password, $hash);
    // ok: jgates.php.password-transformed-before-verify
    $hashed2 = Hash::make($password);
    // ruleid: jgates.php.password-transformed-before-verify
    $viaRequest = Hash::make(strtolower($request->input('password')));
    // ok: jgates.php.password-transformed-before-verify
    $email = strtolower($email);
    // ok: jgates.php.password-transformed-before-verify
    $found = Hash::check($password, $hash) && strtolower($email) !== '';
    return [$stored, $good, $hashed, $stored2, $good2, $hashed2, $found];
}

// ---- session-id-not-regenerated ----
function login_fixed_session(string $email, string $password, array $user): bool
{
    if (password_verify($password, $user['hash'])) {
        // ruleid: jgates.php.session-id-not-regenerated
        $_SESSION['user_id'] = $user['id'];
        return true;
    }
    return false;
}

class LoginHandler
{
    public function signIn(string $password, $account): bool
    {
        if (Hash::check($password, $account->password)) {
            // ruleid: jgates.php.session-id-not-regenerated
            $_SESSION['auth_user'] = $account->id;
            return true;
        }
        return false;
    }

    public function signInRenewed(string $password, $account): bool
    {
        if (Hash::check($password, $account->password)) {
            session_regenerate_id(true);
            // ok: jgates.php.session-id-not-regenerated
            $_SESSION['auth_user'] = $account->id;
            return true;
        }
        return false;
    }

    public function savePreference(string $theme): void
    {
        // ok: jgates.php.session-id-not-regenerated
        $_SESSION['theme'] = $theme;
    }
}

function login_renewed(string $password, array $user): bool
{
    if (password_verify($password, $user['hash'])) {
        session_regenerate_id(true);
        // ok: jgates.php.session-id-not-regenerated
        $_SESSION['user_id'] = $user['id'];
        return true;
    }
    return false;
}

// ---- client-controlled-privilege ----
function privilege_cases($request, $user)
{
    // ruleid: jgates.php.client-controlled-privilege
    $user->role = $request->input('role');
    // ruleid: jgates.php.client-controlled-privilege
    $_SESSION['role'] = $_POST['role'];
    $wanted = $_GET['is_admin'];
    // ruleid: jgates.php.client-controlled-privilege
    $account = User::create(['name' => 'Ana', 'is_admin' => $wanted]);
    // ruleid: jgates.php.client-controlled-privilege
    $user->assignRole($request->input('role'));
}

function privilege_safe_cases($request, $user)
{
    // ok: jgates.php.client-controlled-privilege
    $user->role = 'member';
    // ok: jgates.php.client-controlled-privilege
    $other = User::create(['name' => $request->input('name'), 'role' => 'member']);
    // ok: jgates.php.client-controlled-privilege
    $user->assignRole('member');
    // ok: jgates.php.client-controlled-privilege
    $_SESSION['role'] = $user->storedRole();
    // ok: jgates.php.client-controlled-privilege
    $user->name = $request->input('name');
}

// ---- permit-all-requests ----
function permit_all_cases()
{
    // ruleid: jgates.php.permit-all-requests
    Gate::before(fn($user) => true);
    // ruleid: jgates.php.permit-all-requests
    Gate::before(function ($user, $ability) {
        return true;
    });
    // ok: jgates.php.permit-all-requests
    Gate::before(fn($user) => $user->isSuperAdmin() ? true : null);
    // ok: jgates.php.permit-all-requests
    Gate::define('edit-post', fn($user, $post) => $user->id === $post->user_id);
}

// ---- totp-window-too-wide ----
function totp_cases($google2fa, $tfa, $secret, $code)
{
    // ruleid: jgates.php.totp-window-too-wide
    $slow = TOTP::create($secret, 60);
    // ruleid: jgates.php.totp-window-too-wide
    $client = new TwoFactorAuth('Example', 6, 90);
    // ruleid: jgates.php.totp-window-too-wide
    $google2fa->setKeyRegeneration(120);
    // ruleid: jgates.php.totp-window-too-wide
    $okA = $tfa->verifyCode($secret, $code, 4);
    // ruleid: jgates.php.totp-window-too-wide
    $okB = $google2fa->verifyKey($secret, $code, 5);
    // ok: jgates.php.totp-window-too-wide
    $normal = TOTP::create($secret, 30);
    // ok: jgates.php.totp-window-too-wide
    $default = TOTP::create($secret);
    // ok: jgates.php.totp-window-too-wide
    $client2 = new TwoFactorAuth('Example', 6, 30);
    // ok: jgates.php.totp-window-too-wide
    $okC = $tfa->verifyCode($secret, $code, 1);
    // ok: jgates.php.totp-window-too-wide
    $okD = $google2fa->verifyKey($secret, $code);
}

// ---- secret-question-present ----
function secret_question_cases($user, $answer, $question)
{
    // ruleid: jgates.php.secret-question-present
    $user->secret_question = $question;
    // ruleid: jgates.php.secret-question-present
    $row = ['security_answer' => $answer];
    // ruleid: jgates.php.secret-question-present
    $securityQuestion = $question;
    // ok: jgates.php.secret-question-present
    $user->recovery_email = 'a@example.com';
    // ok: jgates.php.secret-question-present
    $row2 = ['totp_secret' => $answer];
    // ok: jgates.php.secret-question-present
    $faq = ['question' => $question];
}
