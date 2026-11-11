using Calc;
using Xunit;

public class AgeTests
{
    [Theory]
    [InlineData(17, false)]
    [InlineData(18, true)]
    [InlineData(40, true)]
    public void IsAdult(int age, bool adult) => Assert.Equal(adult, Age.IsAdult(age));

    [Theory]
    [InlineData(12, "child")]
    [InlineData(13, "teen")]
    [InlineData(17, "teen")]
    [InlineData(18, "adult")]
    public void Group(int age, string group) => Assert.Equal(group, Age.Group(age));
}
