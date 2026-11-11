using Calc;
using Xunit;

public class AgeTests
{
    [Fact]
    public void AnAdult() => Assert.True(Age.IsAdult(40));
}
