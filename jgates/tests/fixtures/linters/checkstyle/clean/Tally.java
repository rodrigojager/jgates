package demo;

/**
 * Keeps a running total.
 */
public class Tally {

    /**
     * The running total.
     */
    private int total;

    /**
     * Adds a number to the total.
     *
     * @param number the number to add
     * @return the new total
     */
    public int add(final int number) {
        total += number;
        return total;
    }
}
