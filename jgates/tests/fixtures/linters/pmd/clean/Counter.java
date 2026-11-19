package demo;

/**
 * Counts upwards.
 */
public class Counter {

    /**
     * The current count.
     */
    private int count;

    /**
     * Moves to the next number.
     *
     * @return the new count
     */
    public int next() {
        count++;
        return count;
    }
}
