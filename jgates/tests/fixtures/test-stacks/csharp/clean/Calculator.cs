namespace Calc;

public static class Calculator
{
    public static int Add(int a, int b) => a + b;

    public static int Absolute(int x)
    {
        if (x < 0)
        {
            return -x;
        }
        return x;
    }
}
