<?php

namespace App\Services;

use App\Models\Model;

class OrderService
{
    public function find(int $id): Model
    {
        return new Model(['id' => $id]);
    }
}
