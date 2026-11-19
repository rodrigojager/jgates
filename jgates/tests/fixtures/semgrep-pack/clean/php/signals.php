<?php
namespace App\Http;

use App\Support\Greeter;

// A small controller that uses none of the technologies of the signal list. The names below only mention them.
// use GraphQL\GraphQL; new Memcached(); ldap_connect(); uses-jwt and uses-saml appear in this comment only.
const NOTE = 'use Firebase\\JWT\\JWT; new ZipArchive(); mail() and move_uploaded_file() are only words here';

function serve(Greeter $greeter)
{
    $greeting = trim(' hello ');
    return $greeter->greet(strtoupper($greeting));
}
