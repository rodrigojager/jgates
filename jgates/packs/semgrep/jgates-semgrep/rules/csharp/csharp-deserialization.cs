using System.IO;
using System.Runtime.Serialization.Formatters.Binary;
using System.Xml;
using Newtonsoft.Json;

public class DeserializationSamples
{
    public object Restore(Stream input)
    {
        // ruleid: jgates.csharp.unsafe-deserialization
        var formatter = new BinaryFormatter();
        // ruleid: jgates.csharp.unsafe-deserialization
        var settings = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.All };
        // ruleid: jgates.csharp.unsafe-deserialization
        settings.TypeNameHandling = TypeNameHandling.Auto;
        // ok: jgates.csharp.unsafe-deserialization
        var safe = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.None };
        // ok: jgates.csharp.unsafe-deserialization
        var plain = new JsonSerializerSettings();
        return formatter.Deserialize(input);
    }

    public void Parse(Stream input)
    {
        // ruleid: jgates.csharp.xml-external-entity
        var a = new XmlReaderSettings { DtdProcessing = DtdProcessing.Parse };
        var doc = new XmlDocument();
        // ruleid: jgates.csharp.xml-external-entity
        doc.XmlResolver = new XmlUrlResolver();
        // ruleid: jgates.csharp.xml-external-entity
        a.ProhibitDtd = false;
        // ok: jgates.csharp.xml-external-entity
        var b = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit };
        // ok: jgates.csharp.xml-external-entity
        doc.XmlResolver = null;
    }
}
