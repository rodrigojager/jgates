<?php

use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Route;
use Whoops\Handler\PrettyPageHandler;

// ---- debug-mode-enabled ----
function debug_cases($app, $env)
{
    // ruleid: jgates.php.debug-mode-enabled
    ini_set('display_errors', '1');
    // ruleid: jgates.php.debug-mode-enabled
    ini_set('display_startup_errors', 'On');
    // ruleid: jgates.php.debug-mode-enabled
    define('WP_DEBUG', true);
    // ruleid: jgates.php.debug-mode-enabled
    $kernel = new Kernel($env, true);
    // ruleid: jgates.php.debug-mode-enabled
    $app->addErrorMiddleware(true, true, true);
    // ruleid: jgates.php.debug-mode-enabled
    $whoops = new PrettyPageHandler();
    // ruleid: jgates.php.debug-mode-enabled
    Configure::write('debug', true);
    // ruleid: jgates.php.debug-mode-enabled
    $cfg = ['name' => 'app', 'debug' => env('APP_DEBUG', true)];
    // ok: jgates.php.debug-mode-enabled
    ini_set('display_errors', '0');
    // ok: jgates.php.debug-mode-enabled
    define('WP_DEBUG', false);
    // ok: jgates.php.debug-mode-enabled
    $kernel = new Kernel($env, false);
    // ok: jgates.php.debug-mode-enabled
    $app->addErrorMiddleware(false, true, true);
    // ok: jgates.php.debug-mode-enabled
    $cfg = ['name' => 'app', 'debug' => env('APP_DEBUG', false)];
    if ($env === 'dev') {
        // ok: jgates.php.debug-mode-enabled
        ini_set('display_errors', '1');
        // ok: jgates.php.debug-mode-enabled
        $whoops = new PrettyPageHandler();
    }
}

// ---- docs-or-monitoring-endpoint-exposed ----
// ruleid: jgates.php.docs-or-monitoring-endpoint-exposed
Route::get('/metrics', [MetricsController::class, 'index']);
// ruleid: jgates.php.docs-or-monitoring-endpoint-exposed
Route::get('/swagger', [DocsController::class, 'ui']);
// ruleid: jgates.php.docs-or-monitoring-endpoint-exposed
$app->get('/actuator', function ($req, $res) { return $res; });
// ok: jgates.php.docs-or-monitoring-endpoint-exposed
Route::get('/metrics', [MetricsController::class, 'index'])->middleware('auth');
// ok: jgates.php.docs-or-monitoring-endpoint-exposed
Route::get('/users', [UserController::class, 'index']);
// ok: jgates.php.docs-or-monitoring-endpoint-exposed
Route::middleware(['auth'])->group(function () {
    Route::get('/telescope', [TelescopeController::class, 'index']);
});
if ($env === 'local') {
    // ok: jgates.php.docs-or-monitoring-endpoint-exposed
    Route::get('/api/documentation', [DocsController::class, 'ui']);
}

// ---- version-header-exposed ----
function header_cases($response)
{
    // ruleid: jgates.php.version-header-exposed
    header('X-Powered-By: PHP/8.2.4');
    // ruleid: jgates.php.version-header-exposed
    header('Server: Apache/2.4.57');
    // ruleid: jgates.php.version-header-exposed
    $response = $response->withHeader('X-Powered-By', 'Express 4.18');
    // ruleid: jgates.php.version-header-exposed
    $response->headers->set('Server', 'nginx/1.25.1');
    // ok: jgates.php.version-header-exposed
    header_remove('X-Powered-By');
    // ok: jgates.php.version-header-exposed
    header('Content-Type: application/json');
    // ok: jgates.php.version-header-exposed
    $response = $response->withHeader('Cache-Control', 'no-store');
}

// ---- mass-assignment ----
class Account extends Model
{
    // ruleid: jgates.php.mass-assignment
    protected $guarded = [];
}

class Profile extends Model
{
    // ok: jgates.php.mass-assignment
    protected $fillable = ['name', 'email'];
}

function assign_cases($request, $user)
{
    // ruleid: jgates.php.mass-assignment
    User::create($request->all());
    // ruleid: jgates.php.mass-assignment
    $user->update($request->input());
    // ruleid: jgates.php.mass-assignment
    $user->fill($_POST);
    // ruleid: jgates.php.mass-assignment
    Model::unguard();
    // ok: jgates.php.mass-assignment
    User::create($request->validated());
    // ok: jgates.php.mass-assignment
    $user->update($request->only(['name', 'email']));
    // ok: jgates.php.mass-assignment
    $user->fill(['name' => $request->input('name')]);
}

// ---- serializer-exposes-all-fields ----
class UserResource extends JsonResource
{
    public function toArray($request)
    {
        // ruleid: jgates.php.serializer-exposes-all-fields
        return parent::toArray($request);
    }
}

class OrderResource extends JsonResource
{
    public function toArray($request)
    {
        // ruleid: jgates.php.serializer-exposes-all-fields
        return $this->resource->toArray();
    }
}

class SafeResource extends JsonResource
{
    public function toArray($request)
    {
        // ok: jgates.php.serializer-exposes-all-fields
        return ['id' => $this->id, 'name' => $this->name];
    }
}

class PlainHelper
{
    public function toArray($request)
    {
        // ok: jgates.php.serializer-exposes-all-fields
        return parent::toArray($request);
    }
}

// ---- loose-comparison-of-secret ----
function compare_cases($input, $stored, $user, $list)
{
    // ruleid: jgates.php.loose-comparison-of-secret
    if (md5($input) == $stored) {
        return true;
    }
    // ruleid: jgates.php.loose-comparison-of-secret
    if ($_POST['token'] == $_SESSION['token']) {
        return true;
    }
    // ruleid: jgates.php.loose-comparison-of-secret
    if ($user->password != $input) {
        return false;
    }
    // ruleid: jgates.php.loose-comparison-of-secret
    if (in_array($input_token, $list)) {
        return true;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if (hash_equals($stored, md5($input))) {
        return true;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if (password_verify($input, $user->password_hash)) {
        return true;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if ($_POST['token'] === $_SESSION['token']) {
        return true;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if ($user->token == null) {
        return false;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if (count($list) == 3 || $type == 'password') {
        return false;
    }
    // ok: jgates.php.loose-comparison-of-secret
    if (in_array($role, $list)) {
        return true;
    }
}
