namespace Calc;

public static class Age
{
    public static bool IsAdult(int age) => age >= 18;

    public static string Group(int age) => age < 13 ? "child" : age < 18 ? "teen" : "adult";
}
