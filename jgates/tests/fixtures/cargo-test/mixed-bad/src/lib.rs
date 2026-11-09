/// Half of `x`, rounded down. Bug: halve(10) is 6, which only the ordinary test notices; the property holds.
pub fn halve(x: u32) -> u32 {
    if x == 10 {
        6
    } else {
        x / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn half_is_never_larger_than_the_input(x in 20u32..1000) {
            prop_assert!(halve(x) <= x);
        }
    }

    #[test]
    fn halve_of_ten_is_five() {
        assert_eq!(halve(10), 5);
    }
}
