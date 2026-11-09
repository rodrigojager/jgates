/// Half of `x`, rounded down.
pub fn halve(x: u32) -> u32 {
    x / 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn twice_the_half_never_exceeds_the_input(x in 0u32..1000) {
            prop_assert!(halve(x) * 2 <= x);
        }

        #[test]
        fn half_is_never_larger_than_the_input(x in 0u32..1000) {
            prop_assert!(halve(x) <= x);
        }
    }

    #[test]
    fn halve_of_ten_is_five() {
        assert_eq!(halve(10), 5);
    }
}
