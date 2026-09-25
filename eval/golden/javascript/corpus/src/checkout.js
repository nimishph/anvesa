import { Cart, total } from './cart.js';
import { charge } from './payments.js';

export function checkout(items) {
  const amount = total(items);
  return charge(amount);
}

export function fill(items) {
  const cart = new Cart();
  items.forEach((item) => cart.add(item));
  return cart;
}
