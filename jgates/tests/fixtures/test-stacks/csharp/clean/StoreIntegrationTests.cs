using System.Collections.Generic;
using Xunit;

namespace Calc.Tests;

[Trait("Category", "Integration")]
public class StoreIntegrationTests
{
    [Fact]
    public void StoreRoundTrip()
    {
        var store = new Dictionary<string, int> { ["total"] = Calculator.Add(1, 2) };
        Assert.Equal(3, store["total"]);
    }

    [Fact]
    public void SumOfMany()
    {
        var total = 0;
        for (var value = 0; value < 5; value++)
        {
            total = Calculator.Add(total, value);
        }
        Assert.Equal(10, total);
    }
}
