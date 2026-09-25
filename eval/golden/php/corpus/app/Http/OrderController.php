<?php

namespace App\Http;

use App\Models\Model;
use App\Services\OrderService;
use Illuminate\Http\Request;

class OrderController
{
    public function __construct(private OrderService $service)
    {
    }

    public function show(Request $request, int $id)
    {
        $order = $this->service->find($id);
        $order->save();

        return $request->get('format');
    }

    public function make()
    {
        return new Model([]);
    }
}
