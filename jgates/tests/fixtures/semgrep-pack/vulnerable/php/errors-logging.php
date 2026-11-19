<?php

use GuzzleHttp\Client;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

class AccountController
{
    private $httpClient;

    public function login($request, string $password)
    {
        Log::info('login attempt', ['password' => $password]);
    }

    public function failure(\Throwable $e): Response
    {
        return new Response('Error: ' . $e->getTraceAsString(), 500);
    }

    public function detail(\Exception $e)
    {
        echo 'Failed: ' . $e->getMessage();
    }

    public function cleanup($pdo)
    {
        try {
            $pdo->exec('DELETE FROM sessions');
        } catch (\Exception $e) {
        }
    }

    public function fetch(string $url)
    {
        $client = new Client();
        return $client->get($url)->getBody();
    }

    public function proxy($request)
    {
        return $this->httpClient->get($_GET['url']);
    }
}
