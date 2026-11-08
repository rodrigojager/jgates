"use strict";

// The boundary is at 18: an adult is 18 or older.
function isAdult(age) {
  return age >= 18;
}

// Orders above 100 get a ten percent discount; exactly 100 does not.
function price(total) {
  if (total > 100) return total - total / 10;
  return total;
}

module.exports = { isAdult, price };
