<?php

use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;
use OTPHP\TOTP;

class AccountController
{
    public function rules(): array
    {
        return [
            'email' => 'required|email',
            'password' => 'required|min:10|max:128',
        ];
    }

    public function strongRule()
    {
        return Password::min(10)->uncompromised();
    }

    public function register($request, $user): void
    {
        $user->password = Hash::make($request->input('password'));
        $user->role = 'member';
        $user->recovery_email = $request->input('recovery_email');
        $user->save();
    }

    public function login(string $password, array $account): bool
    {
        if (password_verify($password, $account['hash'])) {
            session_regenerate_id(true);
            $_SESSION['user_id'] = $account['id'];
            return true;
        }
        return false;
    }
}

function boot_authorization(): void
{
    Gate::before(fn($user) => $user->isSuperAdmin() ? true : null);
}

function make_totp(string $secret)
{
    return TOTP::create($secret, 30);
}
