<?php

declare(strict_types=1);

namespace Fixture;

final class Undefined
{
    public function value(): int
    {
        return strlen('abc');
    }
}
