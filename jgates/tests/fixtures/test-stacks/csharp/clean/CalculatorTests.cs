using FsCheck.Xunit;
using Xunit;

namespace Calc.Tests;

public class CalculatorTests
{
    [Fact]
    public void AddsTwoNumbers()
    {
        Assert.Equal(5, Calculator.Add(2, 3));
    }

    [Fact]
    public void AbsoluteValue()
    {
        Assert.Equal(4, Calculator.Absolute(-4));
        Assert.Equal(4, Calculator.Absolute(4));
    }

    [Property]
    public bool AdditionIsCommutative(int a, int b)
    {
        return Calculator.Add(a, b) == Calculator.Add(b, a);
    }
}
