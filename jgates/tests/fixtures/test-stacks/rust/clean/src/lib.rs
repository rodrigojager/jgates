/// The sum of a and b.
pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

/// The absolute value of x.
pub fn absolute(x: i64) -> i64 {
    if x < 0 {
        -x
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn adds_two_numbers() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn absolute_value() {
        assert_eq!(absolute(-4), 4);
        assert_eq!(absolute(4), 4);
    }

    proptest! {
        #[test]
        fn addition_is_commutative(a in -1000i64..1000, b in -1000i64..1000) {
            prop_assert_eq!(add(a, b), add(b, a));
        }
    }
}
