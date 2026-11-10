function add(a, b) {
  return a + b;
}

function absolute(x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

function clamp(value, low, high) {
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

function sign(x) {
  if (x > 0) {
    return 1;
  }
  if (x < 0) {
    return -1;
  }
  return 0;
}

module.exports = { add, absolute, clamp, sign };
