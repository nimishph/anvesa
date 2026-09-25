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
