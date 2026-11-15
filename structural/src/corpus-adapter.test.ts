import { describe, expect, test } from 'bun:test';
import { docblockAnnotationAdapter, routeEndpointAdapter } from './corpus-adapter.ts';

describe('DocblockAnnotationCorpusAdapter', () => {
  test('extracts @tag annotations from docblocks', () => {
    const content = `
    /**
     * @owner alice
     * @auth jwt
     */
    export function secureEndpoint() {}
    `;
    const records = docblockAnnotationAdapter.extract({
      path: 'src/api.ts',
      content,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.attrs.tag).toBe('owner');
    expect(records[0]?.attrs.value).toBe('alice');
    expect(records[1]?.attrs.tag).toBe('auth');
    expect(records[1]?.attrs.value).toBe('jwt');
  });
});

describe('RouteEndpointCorpusAdapter', () => {
  test('extracts Laravel routes', () => {
    const content = `
    Route::get('/orders/{id}', [OrderController::class, 'get']);
    Route::post('/cart/payment', 'CartController@purchase');
    Route::delete('/orders/{id}', function() {});
    `;
    const records = routeEndpointAdapter.extract({
      path: 'routes/api.php',
      content,
    });

    expect(records).toHaveLength(3);
    expect(records[0]?.attrs.method).toBe('GET');
    expect(records[0]?.attrs.route).toBe('/orders/{id}');
    expect(records[0]?.attrs.handler).toBe('OrderController::class.get');
    expect(records[0]?.attrs.framework).toBe('laravel');

    expect(records[1]?.attrs.method).toBe('POST');
    expect(records[1]?.attrs.route).toBe('/cart/payment');
    expect(records[1]?.attrs.handler).toBe('CartController@purchase');

    expect(records[2]?.attrs.method).toBe('DELETE');
  });

  test('Laravel routes carry the prefixes of every group they sit in (#46)', () => {
    const content = `<?php
Route::get('/health', [HealthController::class, 'index']);
Route::prefix('cart')->group(function () {
    Route::get('/', [CartController::class, 'index']);
    Route::post('/add', [CartController::class, 'add']);
    Route::prefix('items')->group(function () {
        // a } in a comment, and in a string: '}'
        Route::delete('/{id}', [CartController::class, 'remove']);
    });
});
Route::group(['prefix' => 'profile'], function () {
    Route::get('/', [ProfileController::class, 'index']);
});
Route::middleware('auth')->prefix('orders')->group(function () {
    Route::get('/{number}', [OrderController::class, 'show']);
});
Route::name('admin.')->group(function () {
    Route::get('/admin', [AdminController::class, 'index']);
});
Route::get('/after', [HealthController::class, 'after']);
`;
    const routes = routeEndpointAdapter
      .extract({ path: 'routes/web.php', content })
      .map((r) => `${r.attrs.method} ${r.attrs.route}`);
    expect(routes).toEqual([
      'GET /health',
      'GET /cart',
      'POST /cart/add',
      'DELETE /cart/items/{id}',
      'GET /profile',
      'GET /orders/{number}',
      'GET /admin',
      'GET /after',
    ]);
  });

  test('extracts Lumen routes on the injected router', () => {
    const content = `
$router->get('/', function () use ($router) { return $router->app->version(); });
$router->post('/login', 'AuthController@login');
$router->group(['prefix' => 'api'], function () use ($router) {
    $router->get('/users/{id}', 'UserController@show');
});
`;
    const records = routeEndpointAdapter.extract({
      path: 'routes/web.php',
      content,
    });

    expect(records).toHaveLength(3);
    expect(records[0]?.attrs.method).toBe('GET');
    expect(records[0]?.attrs.route).toBe('/');
    expect(records[0]?.attrs.framework).toBe('laravel');
    expect(records[1]?.attrs.method).toBe('POST');
    expect(records[1]?.attrs.handler).toBe('AuthController@login');
    expect(records[2]?.attrs.route).toBe('/api/users/{id}');
  });

  test('claims a file with no path hint when it holds $router routes', () => {
    expect(
      routeEndpointAdapter.claim({ path: 'web.php', content: `$router->get('/', fn () => 1);` }),
    ).toBe(true);
  });
  test('extracts Express/Koa routes', () => {
    const content = `
    app.get('/users/:id', getUser);
    router.post('/checkout', checkoutController.process);
    `;
    const records = routeEndpointAdapter.extract({
      path: 'src/server.ts',
      content,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.attrs.method).toBe('GET');
    expect(records[0]?.attrs.route).toBe('/users/:id');
    expect(records[0]?.attrs.handler).toBe('getUser');
    expect(records[0]?.attrs.framework).toBe('express');

    expect(records[1]?.attrs.method).toBe('POST');
    expect(records[1]?.attrs.route).toBe('/checkout');
    expect(records[1]?.attrs.handler).toBe('checkoutController.process');
  });

  test('extracts Next.js file-based route handlers', () => {
    const content = `
    export async function GET(request: Request) { return Response.json({}); }
    export async function POST(request: Request) { return Response.json({}); }
    `;
    const records = routeEndpointAdapter.extract({
      path: 'app/api/orders/[id]/route.ts',
      content,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.attrs.method).toBe('GET');
    expect(records[0]?.attrs.route).toBe('/api/orders/[id]');
    expect(records[0]?.attrs.framework).toBe('nextjs');

    expect(records[1]?.attrs.method).toBe('POST');
    expect(records[1]?.attrs.route).toBe('/api/orders/[id]');
  });

  test('extracts client-side Vue/React router routes', () => {
    const content = `
    const routes = [
      { path: '/', component: Home },
      { path: '/admin', component: Admin },
    ];
    `;
    const records = routeEndpointAdapter.extract({
      path: 'src/router.ts',
      content,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.attrs.method).toBe('PAGE');
    expect(records[0]?.attrs.route).toBe('/');

    expect(records[1]?.attrs.method).toBe('PAGE');
    expect(records[1]?.attrs.route).toBe('/admin');
  });
});
