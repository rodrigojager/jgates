<?php

use GuzzleHttp\Client;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

class AccountController
{
    private $httpClient;

    public function login($request, string $password, $user)
    {
        Log::info('login attempt', ['user_id' => $user->id]);
    }

    public function failure(\Throwable $e): Response
    {
        Log::error('request failed', ['exception' => $e]);
        return new Response('Internal error', 500);
    }

    public function detail(\Exception $e)
    {
        Log::warning('request failed', ['reason' => $e->getMessage()]);
        echo 'The request could not be completed';
    }

    public function cleanup($pdo)
    {
        try {
            $pdo->exec('DELETE FROM sessions');
        } catch (\Exception $e) {
            Log::error('cleanup failed', ['exception' => $e]);
        }
    }

    public function fetch(string $url)
    {
        $client = new Client(['timeout' => 5]);
        return $client->get($url)->getBody();
    }

    public function proxy($request)
    {
        return $this->httpClient->get($_GET['url'], ['allow_redirects' => false]);
    }
}
