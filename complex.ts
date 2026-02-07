// Test file for complex diff hunk
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price;
  }
  return total;
}

// Old implementation
function getTotalPrice(cart) {
  return calculateTotal(cart.items);
}