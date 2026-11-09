/// Half of `x`, rounded down. Bug: halve(10) is 6.
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

    #[test]
    fn halve_of_ten_is_five() {
        assert_eq!(halve(10), 5);
    }

    #[test]
    fn halve_of_four_is_two() {
        assert_eq!(halve(4), 2);
    }
}
