<?php

namespace App\Models;

class Model
{
    public function __construct(private array $data)
    {
    }

    public function save(): bool
    {
        return $this->validate();
    }

    private function validate(): bool
    {
        return true;
    }
}
