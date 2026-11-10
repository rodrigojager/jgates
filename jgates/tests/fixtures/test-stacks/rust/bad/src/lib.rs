/// The sum of a and b.
pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

/// Keeps value between low and high.
pub fn clamp(value: i64, low: i64, high: i64) -> i64 {
    if value < low {
        return low;
    }
    if value > high {
        return high;
    }
    value
}

/// -1, 0 or 1.
pub fn sign(x: i64) -> i64 {
    if x > 0 {
        1
    } else if x < 0 {
        -1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_two_numbers() {
        assert_eq!(add(2, 2), 5);
    }

    #[test]
    fn adds_zero() {
        assert_eq!(add(7, 0), 7);
    }
}
