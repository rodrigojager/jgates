using Xunit;

namespace Calc.Tests;

public class CalculatorTests
{
    [Fact]
    public void AddsTwoNumbers()
    {
        Assert.Equal(5, Calculator.Add(2, 2));
    }

    [Fact]
    public void AddsZero()
    {
        Assert.Equal(7, Calculator.Add(7, 0));
    }
}
