package app.signals;

import java.util.List;
import java.util.stream.Collectors;

// A small service that uses none of the technologies of the signal list. The names below only mention them.
// uses-graphql, uses-jwt and uses-ldap appear in this comment only; import javax.mail.Transport; is just text here.
public class Signals {
    private static final String NOTE = "import io.jsonwebtoken.Jwts; and javax.xml.parsers are only words here";

    public String describe(List<String> names) {
        return names.stream().map(String::trim).collect(Collectors.joining(", ")) + NOTE;
    }
}
