<?php

use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Route;

ini_set('display_errors', '0');

Route::get('/metrics', [MetricsController::class, 'index'])->middleware('auth');

class AccountController
{
    public function register($request)
    {
        header_remove('X-Powered-By');
        return User::create($request->validated());
    }

    public function login($request, $user)
    {
        if (hash_equals($_SESSION['token'], $_POST['token'])) {
            return $user;
        }
        return null;
    }
}

class UserResource extends JsonResource
{
    public function toArray($request)
    {
        return ['id' => $this->id, 'name' => $this->name];
    }
}
