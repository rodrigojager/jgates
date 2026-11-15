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
            'password' => 'required|min:6|max:32',
        ];
    }

    public function strongRule()
    {
        return Password::min(10)->mixedCase()->numbers();
    }

    public function register($request, $user): void
    {
        $user->password = Hash::make(strtolower($request->input('password')));
        $user->role = $request->input('role');
        $user->secret_question = $request->input('question');
        $user->save();
    }

    public function login(string $password, array $account): bool
    {
        if (password_verify($password, $account['hash'])) {
            $_SESSION['user_id'] = $account['id'];
            return true;
        }
        return false;
    }
}

function boot_authorization(): void
{
    Gate::before(fn($user) => true);
}

function make_totp(string $secret)
{
    return TOTP::create($secret, 120);
}
