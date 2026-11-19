<?php

declare(strict_types=1);

namespace Fixture;

final class Spacing
{
    public function run(bool $flag): int
    {
        if ($flag) {
            return 1;
        }

        return 0;
    }
}
