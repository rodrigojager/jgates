using System;
using System.Collections.Generic;
using System.Linq;

// A small service that uses none of the technologies of the signal list. The names below only mention them.
namespace Example.Clean
{
    public class Service
    {
        // using HotChocolate.Types; and using System.Xml; appear in this comment only.
        private const string Note = "using System.Net.WebSockets; and using OtpNet; are only words here";

        public string Greet(IEnumerable<string> names)
        {
            return string.Join(", ", names.Select(n => n.Trim()));
        }
    }
}
