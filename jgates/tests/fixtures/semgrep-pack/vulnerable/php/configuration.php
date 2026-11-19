<?php

use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Route;

ini_set('display_errors', '1');

Route::get('/metrics', [MetricsController::class, 'index']);

class AccountController
{
    public function register($request)
    {
        header('X-Powered-By: PHP/8.2.4');
        return User::create($request->all());
    }

    public function login($request, $user)
    {
        if ($_POST['token'] == $_SESSION['token']) {
            return $user;
        }
        return null;
    }
}

class UserResource extends JsonResource
{
    public function toArray($request)
    {
        return parent::toArray($request);
    }
}
