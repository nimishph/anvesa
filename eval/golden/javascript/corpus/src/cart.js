export function total(items) {
  return items.reduce((sum, item) => sum + price(item), 0);
}

function price(item) {
  return item.cents / 100;
}

export class Cart {
  constructor() {
    this.items = [];
  }

  add(item) {
    this.items.push(item);
    return this.count();
  }

  count() {
    return this.items.length;
  }
}
