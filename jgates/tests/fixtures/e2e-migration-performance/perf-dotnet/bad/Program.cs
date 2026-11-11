using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkSwitcher.FromAssembly(typeof(FibBenchmarks).Assembly).Run(args);

public class FibBenchmarks
{
    [Benchmark]
    public long Fib20()
    {
        Thread.Sleep(20);
        long a = 0, b = 1;
        for (var i = 0; i < 20; i++) (a, b) = (b, a + b);
        return a;
    }
}
